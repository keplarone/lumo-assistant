//! Minimal Server-Sent Events decoder over a byte stream.

use futures_util::{Stream, StreamExt};

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

#[derive(Default)]
pub struct SseDecoder {
    buf: String,
}

impl SseDecoder {
    /// Feed bytes; returns every complete event.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        // Normalize CRLF so the frame separator is always "\n\n".
        if self.buf.contains('\r') {
            self.buf = self.buf.replace("\r\n", "\n");
        }
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find("\n\n") {
            let frame: String = self.buf.drain(..pos + 2).collect();
            let mut event = String::new();
            let mut data = Vec::new();
            for line in frame.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
                }
            }
            if !data.is_empty() || !event.is_empty() {
                out.push(SseEvent { event, data: data.join("\n") });
            }
        }
        out
    }
}

/// Adapt a reqwest byte stream into SSE events.
pub fn events<S, E>(stream: S) -> impl Stream<Item = Result<SseEvent, E>>
where
    S: Stream<Item = Result<bytes::Bytes, E>> + Unpin,
{
    let mut dec = SseDecoder::default();
    stream
        .map(move |chunk| match chunk {
            Ok(b) => Ok(dec.push(&b)),
            Err(e) => Err(e),
        })
        .flat_map(|r| {
            futures_util::stream::iter(match r {
                Ok(v) => v.into_iter().map(Ok).collect::<Vec<_>>(),
                Err(e) => vec![Err(e)],
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_split_frames_and_crlf() {
        let mut d = SseDecoder::default();
        assert!(d.push(b"event: ping\r\ndata: {\"a\"").is_empty());
        let ev = d.push(b":1}\r\n\r\nevent: x\ndata: 2\n\n");
        assert_eq!(ev, vec![SseEvent { event: "ping".into(), data: "{\"a\":1}".into() }, SseEvent { event: "x".into(), data: "2".into() }]);
    }
}
