//! The built-in llama.cpp engine. One worker thread owns the loaded model and its context, so a
//! model stays loaded between requests (and between the steps of one agent run) and the prompt
//! prefix that is already in the KV cache is not computed again. The thread loads the model a job
//! asks for, unloads it when a job needs another one, when told to, or after a while without use.
//!
//! A vision model is loaded with its image projector (llama.cpp's multimodal library, "mtmd"), and
//! the two are unloaded together. A prompt with images is split at its first image: the text before
//! it is decoded like any prompt (and reuses the KV cache), the rest, images included, goes through
//! mtmd. Positions after an image no longer count tokens (Qwen3-VL uses M-RoPE), so the cache is only
//! trusted up to the first image; the next request decodes from there again. Correct over fast.

use super::format::{Prompt, IMAGE_MARKER};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::mtmd::{MtmdBitmap, MtmdContext, MtmdContextParams, MtmdInputText};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use parking_lot::Mutex;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// A loaded model is released after this long without a request, to give the memory back.
const IDLE_UNLOAD: Duration = Duration::from_secs(15 * 60);
/// Prompt tokens decoded per batch; cancellation is checked between batches.
const BATCH: usize = 512;
/// Images are scaled down so their long side is at most this many pixels (about 1,000 tokens for a
/// 16:9 screenshot with Qwen3-VL's 32-pixel patches).
pub const MAX_IMAGE_SIDE: u32 = 1280;

#[derive(Debug, Clone)]
pub struct Sampling {
    pub temperature: f32,
    pub top_k: i32,
    pub top_p: f32,
    pub min_p: f32,
}

pub struct Job {
    pub path: PathBuf,
    /// The image projector, for a vision model.
    pub mmproj: Option<PathBuf>,
    /// Context window to allocate (capped at what the model was trained for).
    pub n_ctx: u32,
    pub prompt: Prompt,
    pub max_tokens: u32,
    pub sampling: Sampling,
    pub cancel: CancellationToken,
    pub events: tokio::sync::mpsc::UnboundedSender<Gen>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Gen {
    /// Generated text, including special tokens (the parsers need them).
    Piece(String),
    Done {
        prompt_tokens: u64,
        output_tokens: u64,
        hit_limit: bool,
    },
    /// The prompt does not fit the context window.
    TooLong {
        prompt_tokens: usize,
        n_ctx: u32,
    },
    Cancelled,
    Error(String),
}

enum Msg {
    Generate(Box<Job>),
    /// Release the model; the sender (if any) hears back once it is released.
    Unload(Option<mpsc::Sender<()>>),
}

/// Handle to the worker thread; started on first use and restarted if it ever stops.
#[derive(Default)]
pub struct Engine {
    tx: Mutex<Option<mpsc::Sender<Msg>>>,
}

impl Engine {
    pub fn submit(&self, job: Job) {
        let mut msg = Msg::Generate(Box::new(job));
        let mut tx = self.tx.lock();
        for _ in 0..2 {
            let sender = tx.get_or_insert_with(spawn);
            match sender.send(msg) {
                Ok(()) => return,
                Err(mpsc::SendError(m)) => {
                    // The worker stopped (it panicked); start a new one.
                    msg = m;
                    *tx = None;
                }
            }
        }
        if let Msg::Generate(job) = msg {
            let _ = job.events.send(Gen::Error("The on-device engine could not start.".into()));
        }
    }

    /// Release the loaded model, if any, after the current request (on a switch).
    pub fn unload(&self) {
        if let Some(tx) = self.tx.lock().as_ref() {
            let _ = tx.send(Msg::Unload(None));
        }
    }

    /// Release the loaded model and wait (up to `timeout`) until it is, so its file can be deleted
    /// (Windows refuses to delete a file that is mapped into memory).
    pub fn unload_and_wait(&self, timeout: Duration) {
        let (done_tx, done_rx) = mpsc::channel();
        let sent = self.tx.lock().as_ref().is_some_and(|tx| tx.send(Msg::Unload(Some(done_tx))).is_ok());
        if sent {
            let _ = done_rx.recv_timeout(timeout);
        }
    }
}

fn spawn() -> mpsc::Sender<Msg> {
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("lumo-on-device-model".into()).stack_size(8 << 20).spawn(move || worker(rx));
    if let Err(e) = spawned {
        log::error!("could not start the on-device engine thread: {e}");
    }
    tx
}

fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: std::sync::OnceLock<Result<LlamaBackend, String>> = std::sync::OnceLock::new();
    BACKEND
        .get_or_init(|| {
            let mut b = LlamaBackend::init().map_err(|e| e.to_string())?;
            if std::env::var_os("LUMO_LLAMA_LOG").is_none() {
                b.void_logs();
            }
            Ok(b)
        })
        .as_ref()
        .map_err(|e| format!("The on-device engine could not start: {e}"))
}

/// `LUMO_GPU=off` keeps everything on the CPU. Used where a GPU is present but can't be trusted, such as
/// the paravirtual Metal device on CI Macs, which returns wrong results.
fn gpu_allowed() -> bool {
    std::env::var("LUMO_GPU").map_or(true, |v| v != "off")
}

/// What the hardware offers, e.g. "Metal", "Vulkan" or "CPU". Starts the backend if needed.
pub fn accelerator() -> String {
    if !gpu_allowed() || backend().is_err() {
        return "CPU".into();
    }
    llama_cpp_2::list_llama_ggml_backend_devices()
        .into_iter()
        .find(|d| d.backend != "CPU" && d.backend != "BLAS")
        .map(|d| if d.backend == "MTL" { "Metal".to_string() } else { d.backend })
        .unwrap_or_else(|| "CPU".into())
}

fn threads() -> i32 {
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let physical = sysinfo::System::physical_core_count().unwrap_or(logical);
    physical.clamp(1, 16) as i32
}

fn load(backend: &LlamaBackend, path: &PathBuf) -> Result<LlamaModel, String> {
    let gpu = gpu_allowed() && backend.supports_gpu_offload();
    let params = LlamaModelParams::default().with_n_gpu_layers(if gpu { 999 } else { 0 });
    match LlamaModel::load_from_file(backend, path, &params) {
        Ok(m) => Ok(m),
        // Not enough GPU memory, or a driver problem: run on the CPU instead.
        Err(e) if gpu => {
            log::warn!("loading the model on the GPU failed ({e}); trying the CPU");
            LlamaModel::load_from_file(backend, path, &LlamaModelParams::default().with_n_gpu_layers(0))
                .map_err(|e| format!("The on-device model could not be loaded: {e}"))
        }
        Err(e) => Err(format!("The on-device model could not be loaded: {e}")),
    }
}

/// A loaded model and, for a vision model, its projector. The projector refers to the model, so it
/// is declared first: fields are dropped in order.
struct Loaded {
    mtmd: Option<MtmdContext>,
    model: LlamaModel,
}

fn load_projector(model: &LlamaModel, mmproj: &std::path::Path) -> Result<MtmdContext, String> {
    let path = mmproj.to_str().ok_or("The image projector's path is not valid text.")?;
    let params = MtmdContextParams {
        use_gpu: gpu_allowed(),
        print_timings: false,
        n_threads: threads(),
        media_marker: std::ffi::CString::new(IMAGE_MARKER).map_err(|e| e.to_string())?,
        image_min_tokens: -1,
        image_max_tokens: -1,
    };
    let ctx = MtmdContext::init_from_file(path, model, &params)
        .map_err(|e| format!("The on-device model's image projector could not be loaded: {e}"))?;
    if !ctx.support_vision() {
        return Err("The on-device model's image projector does not support images.".into());
    }
    Ok(ctx)
}

fn worker(rx: mpsc::Receiver<Msg>) {
    let mut pending: Option<Box<Job>> = None;
    loop {
        let job = match pending.take() {
            Some(j) => j,
            None => match rx.recv() {
                Ok(Msg::Generate(j)) => j,
                Ok(Msg::Unload(ack)) => {
                    if let Some(a) = ack {
                        let _ = a.send(());
                    }
                    continue;
                }
                Err(_) => return,
            },
        };
        let backend = match backend() {
            Ok(b) => b,
            Err(e) => {
                let _ = job.events.send(Gen::Error(e));
                continue;
            }
        };
        let model = match load(backend, &job.path) {
            Ok(m) => m,
            Err(e) => {
                let _ = job.events.send(Gen::Error(e));
                continue;
            }
        };
        let mtmd = match job.mmproj.as_deref().map(|p| load_projector(&model, p)).transpose() {
            Ok(m) => m,
            Err(e) => {
                let _ = job.events.send(Gen::Error(e));
                continue;
            }
        };
        let loaded = Loaded { mtmd, model };
        let key = (job.path.clone(), job.mmproj.clone());
        let mut session: Option<Session> = None;
        let mut next = Some(job);
        let mut ack = None;
        while let Some(job) = next.take() {
            run_job(backend, &loaded, &mut session, *job);
            // Keep the model while jobs for it keep coming.
            match rx.recv_timeout(IDLE_UNLOAD) {
                Ok(Msg::Generate(j)) if (&j.path, &j.mmproj) == (&key.0, &key.1) => next = Some(j),
                Ok(Msg::Generate(j)) => pending = Some(j),
                Ok(Msg::Unload(a)) => ack = a,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        // Free the context, then the projector and the model.
        drop(session);
        drop(loaded);
        if let Some(a) = ack {
            let _ = a.send(());
        }
    }
}

/// A context (KV cache) and the tokens it holds.
struct Session<'m> {
    ctx: LlamaContext<'m>,
    n_ctx: u32,
    cached: Vec<LlamaToken>,
}

fn run_job<'m>(backend: &LlamaBackend, loaded: &'m Loaded, session: &mut Option<Session<'m>>, job: Job) {
    let events = job.events.clone();
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| generate(backend, loaded, session, &job)));
    match res {
        Ok(Ok(ev)) => {
            let _ = events.send(ev);
        }
        Ok(Err(e)) => {
            // The cache may be in any state after an error.
            *session = None;
            let _ = events.send(Gen::Error(e));
        }
        Err(_) => {
            *session = None;
            let _ = events.send(Gen::Error("The on-device engine stopped unexpectedly.".into()));
        }
    }
}

fn prompt_text(model: &LlamaModel, prompt: &Prompt) -> Result<String, String> {
    match prompt {
        Prompt::Raw(s) => Ok(s.clone()),
        Prompt::Chat { turns, suffix, .. } => {
            // The model's own template from its GGUF metadata, applied by llama.cpp.
            let tmpl = model
                .chat_template(None)
                .or_else(|_| LlamaChatTemplate::new("chatml"))
                .map_err(|e| format!("The model's chat template could not be read: {e}"))?;
            let msgs = turns
                .iter()
                .map(|(r, c)| LlamaChatMessage::new(r.clone(), c.replace('\0', "")))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            let mut s =
                model.apply_chat_template(&tmpl, &msgs, true).map_err(|e| format!("The chat template could not be applied: {e}"))?;
            s.push_str(suffix);
            Ok(s)
        }
    }
}

/// An image, decoded and scaled down so its long side is at most `MAX_IMAGE_SIDE`, as RGB bytes.
pub fn decode_image(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("An image could not be read: {e}"))?;
    let img = if img.width().max(img.height()) > MAX_IMAGE_SIDE {
        img.resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let rgb = img.to_rgb8();
    Ok((rgb.width(), rgb.height(), rgb.into_raw()))
}

/// The prompt as the engine decodes it: plain tokens up to the first image, then (with images) the
/// rest as mtmd chunks.
struct Tokenized {
    head: Vec<LlamaToken>,
    rest: Option<llama_cpp_2::mtmd::MtmdInputChunks>,
}

impl Tokenized {
    /// KV cells the prompt fills.
    fn len(&self) -> usize {
        self.head.len() + self.rest.as_ref().map_or(0, |r| r.total_tokens())
    }
}

fn tokenize(model: &LlamaModel, mtmd: Option<&MtmdContext>, job: &Job) -> Result<Tokenized, String> {
    let text = prompt_text(model, &job.prompt)?;
    let images: &[Vec<u8>] = match &job.prompt {
        Prompt::Chat { images, .. } => images.as_slice(),
        Prompt::Raw(_) => &[],
    };
    let vocab = model.vocab();
    if images.is_empty() {
        return Ok(Tokenized { head: vocab.tokenize(text.as_bytes(), true, true), rest: None });
    }
    let mtmd = mtmd.ok_or("This on-device model can't read images.")?;
    if text.matches(IMAGE_MARKER).count() != images.len() {
        return Err("The prompt's images didn't line up with the text.".into());
    }
    let split = text.find(IMAGE_MARKER).unwrap_or(text.len());
    let head = vocab.tokenize(text[..split].as_bytes(), true, true);
    let bitmaps = images
        .iter()
        .map(|b| {
            let (w, h, rgb) = decode_image(b)?;
            MtmdBitmap::from_image_data(w, h, &rgb).map_err(|e| format!("An image could not be prepared: {e}"))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let refs: Vec<&MtmdBitmap> = bitmaps.iter().collect();
    let rest = mtmd
        .tokenize(MtmdInputText { text: text[split..].to_string(), add_special: false, parse_special: true }, &refs)
        .map_err(|e| format!("The images could not be prepared for the model: {e}"))?;
    Ok(Tokenized { head, rest: Some(rest) })
}

fn generate<'m>(backend: &LlamaBackend, loaded: &'m Loaded, session: &mut Option<Session<'m>>, job: &Job) -> Result<Gen, String> {
    let model = &loaded.model;
    let prompt = tokenize(model, loaded.mtmd.as_ref(), job)?;
    let tokens = &prompt.head;
    let vocab = model.vocab();
    if prompt.len() == 0 {
        return Err("The prompt was empty.".into());
    }

    let n_ctx = job.n_ctx.min(model.n_ctx_train().max(1024));
    if session.as_ref().is_some_and(|s| s.n_ctx != n_ctx) {
        *session = None;
    }
    if session.is_none() {
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx))
            .with_n_batch(BATCH as u32)
            .with_n_threads(threads())
            .with_n_threads_batch(threads())
            .with_offload_kqv(gpu_allowed())
            .with_op_offload(gpu_allowed());
        let ctx = model.new_context(backend, params).map_err(|e| format!("The on-device model could not start: {e}"))?;
        *session = Some(Session { ctx, n_ctx, cached: Vec::new() });
    }
    let s = session.as_mut().expect("session");

    // Leave room for at least a short answer.
    let room = (job.max_tokens as usize).min(1024);
    if prompt.len() + room > n_ctx as usize {
        return Ok(Gen::TooLong { prompt_tokens: prompt.len(), n_ctx });
    }

    // Reuse the part of the prompt already in the cache. Without images at least one token is
    // decoded again so there are logits to sample from; with images the chunks after the head do.
    let reusable = if prompt.rest.is_some() { tokens.len() } else { tokens.len() - 1 };
    let mut keep = s.cached.iter().zip(tokens).take_while(|(a, b)| a == b).count().min(reusable);
    if !matches!(s.ctx.clear_kv_cache_seq(Some(0), Some(keep as u32), None), Ok(true)) {
        s.ctx.clear_kv_cache();
        keep = 0;
    }
    s.cached.truncate(keep);

    let mut batch = LlamaBatch::new(BATCH, 1);
    // Next position, and KV cells in use (they differ after an image).
    let mut pos = keep;
    let mut used = keep;
    for chunk in tokens[keep..].chunks(BATCH) {
        if job.cancel.is_cancelled() {
            return Ok(Gen::Cancelled);
        }
        batch.clear();
        for (i, t) in chunk.iter().enumerate() {
            let last = prompt.rest.is_none() && pos + i == tokens.len() - 1;
            batch.add(*t, (pos + i) as i32, &[0], last).map_err(|e| e.to_string())?;
        }
        s.ctx.decode(&mut batch).map_err(|e| format!("The on-device model failed: {e}"))?;
        s.cached.extend_from_slice(chunk);
        pos += chunk.len();
        used += chunk.len();
    }
    // Only plain text keeps the cache in step with the tokens: stop tracking after an image.
    let track = prompt.rest.is_none();
    if let (Some(rest), Some(mtmd)) = (&prompt.rest, loaded.mtmd.as_ref()) {
        if job.cancel.is_cancelled() {
            return Ok(Gen::Cancelled);
        }
        let n_past = rest
            .eval_chunks(mtmd, &s.ctx, pos as i32, 0, BATCH as i32, true)
            .map_err(|e| format!("The on-device model failed to read an image: {e}"))?;
        pos = n_past.max(0) as usize;
        used += rest.total_tokens();
    }

    let seed = rand::random::<u32>();
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::top_k(job.sampling.top_k),
        LlamaSampler::top_p(job.sampling.top_p, 1),
        LlamaSampler::min_p(job.sampling.min_p, 1),
        LlamaSampler::temp(job.sampling.temperature),
        LlamaSampler::dist(seed),
    ]);

    let mut pending_bytes: Vec<u8> = Vec::new();
    let mut produced = 0u64;
    let mut hit_limit = false;
    loop {
        if job.cancel.is_cancelled() {
            return Ok(Gen::Cancelled);
        }
        // The logits of the last token decoded, whichever way it was.
        let token = sampler.sample(&s.ctx, -1);
        if vocab.is_eog(token) {
            break;
        }
        produced += 1;
        pending_bytes.extend(vocab.token_to_piece(token, true, None));
        // Send only whole UTF-8 characters; keep a partial one for the next token.
        let valid = match std::str::from_utf8(&pending_bytes) {
            Ok(_) => pending_bytes.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => pending_bytes.len(),
        };
        if valid > 0 {
            let piece = String::from_utf8_lossy(&pending_bytes[..valid]).into_owned();
            pending_bytes.drain(..valid);
            if job.events.send(Gen::Piece(piece)).is_err() {
                return Ok(Gen::Cancelled);
            }
        }
        if produced >= job.max_tokens as u64 || used + 1 >= n_ctx as usize {
            hit_limit = true;
            break;
        }
        batch.clear();
        batch.add(token, pos as i32, &[0], true).map_err(|e| e.to_string())?;
        s.ctx.decode(&mut batch).map_err(|e| format!("The on-device model failed: {e}"))?;
        if track {
            s.cached.push(token);
        }
        pos += 1;
        used += 1;
    }
    Ok(Gen::Done { prompt_tokens: prompt.len() as u64, output_tokens: produced, hit_limit })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_marker_is_llama_cpps_default() {
        assert_eq!(IMAGE_MARKER, llama_cpp_2::mtmd::mtmd_default_marker());
    }

    #[test]
    fn images_are_decoded_to_rgb_and_scaled_down() {
        let png = |w, h| {
            let img = image::RgbImage::from_pixel(w, h, image::Rgb([255, 0, 0]));
            let mut out = std::io::Cursor::new(Vec::new());
            img.write_to(&mut out, image::ImageFormat::Png).unwrap();
            out.into_inner()
        };
        let (w, h, rgb) = decode_image(&png(64, 32)).unwrap();
        assert_eq!((w, h, rgb.len()), (64, 32, 64 * 32 * 3));
        assert_eq!(&rgb[..3], &[255, 0, 0]);
        let (w, h, rgb) = decode_image(&png(2560, 1440)).unwrap();
        assert_eq!((w, h), (1280, 720));
        assert_eq!(rgb.len(), (w * h * 3) as usize);
        let (w, h, _) = decode_image(&png(1000, 3000)).unwrap();
        assert_eq!((w, h), (427, 1280));
        assert!(decode_image(b"not an image").is_err());
    }
}
