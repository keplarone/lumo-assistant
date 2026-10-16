//! The built-in llama.cpp engine. One worker thread owns the loaded model and its context, so a
//! model stays loaded between requests (and between the steps of one agent run) and the prompt
//! prefix that is already in the KV cache is not computed again. The thread loads the model a job
//! asks for, unloads it when a job needs another one, when told to, or after a while without use.

use super::format::Prompt;
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaChatTemplate, LlamaModel};
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

#[derive(Debug, Clone)]
pub struct Sampling {
    pub temperature: f32,
    pub top_k: i32,
    pub top_p: f32,
    pub min_p: f32,
}

pub struct Job {
    pub path: PathBuf,
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
        let path = job.path.clone();
        let mut session: Option<Session> = None;
        let mut next = Some(job);
        let mut ack = None;
        while let Some(job) = next.take() {
            run_job(backend, &model, &mut session, *job);
            // Keep the model while jobs for it keep coming.
            match rx.recv_timeout(IDLE_UNLOAD) {
                Ok(Msg::Generate(j)) if j.path == path => next = Some(j),
                Ok(Msg::Generate(j)) => pending = Some(j),
                Ok(Msg::Unload(a)) => ack = a,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        // Free the context, then the model.
        drop(session);
        drop(model);
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

fn run_job<'m>(backend: &LlamaBackend, model: &'m LlamaModel, session: &mut Option<Session<'m>>, job: Job) {
    let events = job.events.clone();
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| generate(backend, model, session, &job)));
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
        Prompt::Chat { turns, suffix } => {
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

fn generate<'m>(backend: &LlamaBackend, model: &'m LlamaModel, session: &mut Option<Session<'m>>, job: &Job) -> Result<Gen, String> {
    let text = prompt_text(model, &job.prompt)?;
    let vocab = model.vocab();
    let tokens = vocab.tokenize(text.as_bytes(), true, true);
    if tokens.is_empty() {
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
    if tokens.len() + room > n_ctx as usize {
        return Ok(Gen::TooLong { prompt_tokens: tokens.len(), n_ctx });
    }

    // Reuse the part of the prompt already in the cache. At least one token is decoded again so
    // there are logits to sample from.
    let mut keep = s.cached.iter().zip(&tokens).take_while(|(a, b)| a == b).count().min(tokens.len() - 1);
    if keep < s.cached.len() && !matches!(s.ctx.clear_kv_cache_seq(Some(0), Some(keep as u32), None), Ok(true)) {
        s.ctx.clear_kv_cache();
        keep = 0;
    }
    s.cached.truncate(keep);

    let mut batch = LlamaBatch::new(BATCH, 1);
    let mut pos = keep;
    for chunk in tokens[keep..].chunks(BATCH) {
        if job.cancel.is_cancelled() {
            return Ok(Gen::Cancelled);
        }
        batch.clear();
        for (i, t) in chunk.iter().enumerate() {
            let last = pos + i == tokens.len() - 1;
            batch.add(*t, (pos + i) as i32, &[0], last).map_err(|e| e.to_string())?;
        }
        s.ctx.decode(&mut batch).map_err(|e| format!("The on-device model failed: {e}"))?;
        s.cached.extend_from_slice(chunk);
        pos += chunk.len();
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
        let token = sampler.sample(&s.ctx, batch.n_tokens() - 1);
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
        if produced >= job.max_tokens as u64 || pos + 1 >= n_ctx as usize {
            hit_limit = true;
            break;
        }
        batch.clear();
        batch.add(token, pos as i32, &[0], true).map_err(|e| e.to_string())?;
        s.ctx.decode(&mut batch).map_err(|e| format!("The on-device model failed: {e}"))?;
        s.cached.push(token);
        pos += 1;
    }
    Ok(Gen::Done { prompt_tokens: tokens.len() as u64, output_tokens: produced, hit_limit })
}
