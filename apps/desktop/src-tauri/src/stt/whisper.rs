//! Whisper inference on the CPU with candle: 16 kHz audio in, text out. Greedy decoding in 30-second
//! windows, as OpenAI's reference does at temperature 0, without timestamps. Adapted from candle's
//! Whisper example (MIT/Apache-2.0).

use crate::error::{LumoError, Result};
use candle_core::{Device, IndexOp, Tensor, D};
use candle_nn::VarBuilder;
use candle_transformers::models::whisper::{self as m, audio, Config};
use std::path::Path;
use tokenizers::Tokenizer;

/// The 80-bin mel filterbank Whisper was trained with (librosa's, as shipped in candle's example).
const MEL_FILTERS_80: &[u8] = include_bytes!("mel_filters_80.bytes");

/// The longest recording transcribed (voice requests are short; this bounds the work).
pub const MAX_SECONDS: usize = 120;

fn err(e: impl std::fmt::Display) -> LumoError {
    LumoError::Unavailable(format!("On-device speech recognition failed: {e}"))
}

pub struct Whisper {
    model: m::model::Whisper,
    tokenizer: Tokenizer,
    filters: Vec<f32>,
    /// Added to the logits: -inf for tokens that must never be produced.
    suppress: Tensor,
    sot: u32,
    eot: u32,
    transcribe: u32,
    no_timestamps: u32,
    no_speech: Option<u32>,
    /// (language code, token) for every language the model knows.
    languages: Vec<(String, u32)>,
    device: Device,
}

impl Whisper {
    /// Load from a folder with config.json, tokenizer.json and model.safetensors.
    pub fn load(dir: &Path) -> Result<Self> {
        let config: Config = serde_json::from_slice(&std::fs::read(dir.join("config.json"))?).map_err(err)?;
        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(err)?;
        let weights = std::fs::read(dir.join("model.safetensors"))?;
        Self::from_parts(config, tokenizer, VarBuilder::from_buffered_safetensors(weights, m::DTYPE, &Device::Cpu).map_err(err)?)
    }

    pub fn from_parts(config: Config, tokenizer: Tokenizer, vb: VarBuilder) -> Result<Self> {
        if config.num_mel_bins != 80 {
            return Err(err(format!("{} mel bins are not supported", config.num_mel_bins)));
        }
        let device = Device::Cpu;
        let token = |t: &str| tokenizer.token_to_id(t).ok_or_else(|| err(format!("the tokenizer has no {t}")));
        let sot = token(m::SOT_TOKEN)?;
        let eot = token(m::EOT_TOKEN)?;
        let transcribe = token(m::TRANSCRIBE_TOKEN)?;
        let no_timestamps = token(m::NO_TIMESTAMPS_TOKEN)?;
        let no_speech = m::NO_SPEECH_TOKENS.iter().find_map(|t| tokenizer.token_to_id(t));
        let languages = tokenizer
            .get_vocab(true)
            .into_iter()
            .filter_map(|(t, id)| {
                let code = t.strip_prefix("<|")?.strip_suffix("|>")?;
                (code.len() <= 3 && code.chars().all(|c| c.is_ascii_lowercase()) && id > eot).then(|| (code.to_string(), id))
            })
            .collect();
        // Never produce the configured non-speech tokens, or anything special except the end.
        let suppress: Vec<f32> = (0..config.vocab_size as u32)
            .map(|i| if (i > eot) || config.suppress_tokens.contains(&i) { f32::NEG_INFINITY } else { 0.0 })
            .collect();
        let suppress = Tensor::new(suppress.as_slice(), &device).map_err(err)?;
        let filters = MEL_FILTERS_80.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let model = m::model::Whisper::load(&vb, config).map_err(err)?;
        Ok(Self { model, tokenizer, filters, suppress, sot, eot, transcribe, no_timestamps, no_speech, languages, device })
    }

    /// Transcribe mono 16 kHz audio. `fallback_lang` (like "en") is used when the spoken language
    /// isn't clear from the audio.
    pub fn transcribe(&mut self, pcm: &[f32], fallback_lang: Option<&str>) -> Result<String> {
        let pcm = &pcm[..pcm.len().min(MAX_SECONDS * m::SAMPLE_RATE)];
        let mut out = String::new();
        for chunk in pcm.chunks(m::N_SAMPLES) {
            // Whisper makes up words ("you", "Thank you.") for silence, so quiet windows are skipped.
            if is_quiet(chunk) {
                continue;
            }
            // Whisper expects 30-second windows; pad the audio with silence to one.
            let mut padded = chunk.to_vec();
            padded.resize(m::N_SAMPLES, 0.0);
            let mel = audio::pcm_to_mel(&self.model.config, &padded, &self.filters);
            let frames = mel.len() / 80;
            let mel = Tensor::from_vec(mel, (1, 80, frames), &self.device).and_then(|t| t.narrow(2, 0, m::N_FRAMES)).map_err(err)?;
            let text = self.window(&mel, fallback_lang).map_err(err)?;
            if !text.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&text);
            }
        }
        Ok(out)
    }

    fn logits(&mut self, tokens: &[u32], features: &Tensor, flush: bool) -> candle_core::Result<Tensor> {
        let t = Tensor::new(tokens, &self.device)?.unsqueeze(0)?;
        let ys = self.model.decoder.forward(&t, features, flush)?;
        let (_, len, _) = ys.dims3()?;
        self.model.decoder.final_linear(&ys.i((..1, len - 1..))?)?.i(0)?.i(0)
    }

    fn language(&mut self, features: &Tensor, fallback: Option<&str>) -> candle_core::Result<Option<u32>> {
        if self.languages.is_empty() {
            return Ok(None); // An English-only model.
        }
        let logits = self.logits(&[self.sot], features, true)?;
        let ids: Vec<u32> = self.languages.iter().map(|(_, id)| *id).collect();
        let probs =
            candle_nn::ops::softmax(&logits.index_select(&Tensor::new(ids.as_slice(), &self.device)?, 0)?, D::Minus1)?.to_vec1::<f32>()?;
        let (best, p) = probs.iter().enumerate().fold((0, 0.0f32), |a, (i, &p)| if p > a.1 { (i, p) } else { a });
        let fallback = fallback.and_then(|f| self.languages.iter().find(|(c, _)| c == f).map(|(_, id)| *id));
        // Short commands can sound like several languages; trust the app's language then.
        Ok(Some(if p < 0.5 { fallback.unwrap_or(ids[best]) } else { ids[best] }))
    }

    fn window(&mut self, mel: &Tensor, fallback_lang: Option<&str>) -> candle_core::Result<String> {
        let features = self.model.encoder.forward(mel, true)?;
        let mut tokens = vec![self.sot];
        if let Some(lang) = self.language(&features, fallback_lang)? {
            tokens.push(lang);
        }
        tokens.extend([self.transcribe, self.no_timestamps]);
        let prompt = tokens.len();
        let max = self.model.config.max_target_positions / 2;
        let mut sum_logprob = 0.0f64;
        let mut no_speech_prob = 0.0f64;
        for i in 0..max {
            let logits = self.logits(&tokens, &features, i == 0)?;
            if i == 0 {
                if let Some(ns) = self.no_speech {
                    no_speech_prob = candle_nn::ops::softmax(&logits, 0)?.i(ns as usize)?.to_scalar::<f32>()? as f64;
                }
            }
            let logits = logits.broadcast_add(&self.suppress)?;
            let next = logits.argmax(0)?.to_scalar::<u32>()?;
            sum_logprob += candle_nn::ops::log_softmax(&logits, 0)?.i(next as usize)?.to_scalar::<f32>()? as f64;
            if next == self.eot {
                break;
            }
            tokens.push(next);
        }
        let generated = &tokens[prompt..];
        let avg_logprob = sum_logprob / (generated.len() + 1) as f64;
        // Silence or noise: Whisper's own rule for "nothing was said".
        if no_speech_prob > m::NO_SPEECH_THRESHOLD && avg_logprob < m::LOGPROB_THRESHOLD {
            return Ok(String::new());
        }
        let text = self.tokenizer.decode(generated, true).map_err(|e| candle_core::Error::Msg(e.to_string()))?;
        Ok(text.trim().to_string())
    }
}

/// No 50 ms stretch louder than about -45 dBFS: nothing a microphone would pick up as speech.
pub fn is_quiet(pcm: &[f32]) -> bool {
    pcm.chunks(800).all(|w| (w.iter().map(|x| x * x).sum::<f32>() / w.len() as f32).sqrt() < 0.006)
}

/// Mono 16 kHz samples from 16-bit little-endian PCM.
pub fn pcm_from_i16_le(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mel_filterbank_is_whispers() {
        use sha2::{Digest, Sha256};
        assert_eq!(MEL_FILTERS_80.len(), 80 * (m::N_FFT / 2 + 1) * 4);
        assert_eq!(hex::encode(Sha256::digest(MEL_FILTERS_80)), "85818f156f7e189453901a515e4726d270d307f976e161cf9403e8caab405498");
    }

    #[test]
    fn quiet_audio_is_skipped() {
        assert!(is_quiet(&[0.0; 16_000]));
        assert!(is_quiet(&vec![0.002; 16_000]));
        let mut speech = vec![0.0; 16_000];
        speech[8_000..9_000].iter_mut().enumerate().for_each(|(i, x)| *x = (i as f32 * 0.1).sin() * 0.2);
        assert!(!is_quiet(&speech));
    }

    #[test]
    fn reads_16_bit_pcm() {
        assert_eq!(pcm_from_i16_le(&[0, 0, 0, 0x40, 0, 0xC0, 1]), vec![0.0, 0.5, -0.5]);
    }

    /// A tiny random model with a made-up tokenizer: checks shapes and the decoding loop without
    /// downloading anything (the real model is tested in CI, see `smoke_whisper_transcribes_speech`).
    #[test]
    fn decodes_with_a_tiny_random_model() {
        let mut vocab = serde_json::Map::new();
        for (i, t) in ["a", "b", "c", "d"].iter().enumerate() {
            vocab.insert(t.to_string(), i.into());
        }
        let specials =
            ["<|endoftext|>", "<|startoftranscript|>", "<|en|>", "<|fr|>", "<|transcribe|>", "<|nocaptions|>", "<|notimestamps|>"];
        let added: Vec<_> = specials
            .iter()
            .enumerate()
            .map(|(i, t)| serde_json::json!({"id": 4 + i, "content": t, "single_word": false, "lstrip": false, "rstrip": false, "normalized": false, "special": true}))
            .collect();
        for (i, t) in specials.iter().enumerate() {
            vocab.insert(t.to_string(), (4 + i).into());
        }
        let tok = serde_json::json!({
            "version": "1.0", "truncation": null, "padding": null, "added_tokens": added,
            "normalizer": null, "pre_tokenizer": null, "post_processor": null, "decoder": null,
            "model": {"type": "WordLevel", "vocab": vocab, "unk_token": "a"}
        });
        let tokenizer = Tokenizer::from_bytes(serde_json::to_vec(&tok).unwrap()).unwrap();
        let config = Config {
            num_mel_bins: 80,
            max_source_positions: 1500,
            d_model: 8,
            encoder_attention_heads: 2,
            encoder_layers: 1,
            vocab_size: 11,
            max_target_positions: 16,
            decoder_attention_heads: 2,
            decoder_layers: 1,
            suppress_tokens: vec![],
        };
        let varmap = candle_nn::VarMap::new();
        let vb = VarBuilder::from_varmap(&varmap, candle_core::DType::F32, &Device::Cpu);
        let mut w = Whisper::from_parts(config, tokenizer, vb).unwrap();
        assert_eq!(w.languages.len(), 2);
        let pcm: Vec<f32> = (0..16_000).map(|i| (i as f32 * 0.05).sin() * 0.3).collect();
        let text = w.transcribe(&pcm, Some("en")).unwrap();
        assert!(text.chars().all(|c| "abcd ".contains(c)), "{text}");
    }
}
