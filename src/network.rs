use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::Duration,
};

pub enum Update {
    Event(Value),
    State(Value),
    Output(String),
    Flows(Vec<Value>),
    Reply(Result<(), String>),
}

pub struct Connection {
    pub updates: Receiver<Update>,
    pub input: Sender<String>,
    url: String,
    sender: Sender<Update>,
    generation: Arc<AtomicUsize>,
    frame: Arc<Mutex<Option<(usize, image::RgbaImage)>>>,
}

fn subscribe(url: String, update: fn(Value) -> Update, tx: Sender<Update>) {
    thread::spawn(move || {
        loop {
            if let Ok(response) = ureq::get(&url).call() {
                for line in BufReader::new(response.into_body().into_reader())
                    .lines()
                    .map_while(Result::ok)
                {
                    let Some(json) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let Ok(value) = serde_json::from_str(json) else {
                        continue;
                    };
                    if tx.send(update(value)).is_err() {
                        return;
                    }
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

impl Connection {
    pub fn new(url: String) -> Self {
        let (sender, updates) = mpsc::channel();
        subscribe(
            format!("{url}/api/events/stream"),
            Update::Event,
            sender.clone(),
        );
        subscribe(
            format!("{url}/api/device/state"),
            Update::State,
            sender.clone(),
        );
        let target_url = url.clone();
        let state_tx = sender.clone();
        thread::spawn(move || {
            let start = || -> Result<(), ureq::Error> {
                let body: Value = ureq::get(format!("{target_url}/api/device/targets"))
                    .call()?
                    .body_mut()
                    .read_json()?;
                if let Some([target]) = body["devices"].as_array().map(Vec::as_slice) {
                    ureq::post(format!("{target_url}/api/device/start")).send_json(target)?;
                }
                Ok(())
            };
            if let Err(error) = start() {
                let _ = state_tx.send(Update::State(
                    json!({"status":"error","message":error.to_string()}),
                ));
            }
        });
        let (input, queue) = mpsc::channel::<String>();
        let endpoint = format!("{url}/api/device/input");
        thread::spawn(move || {
            let agent = ureq::Agent::new_with_defaults();
            for cmd in queue {
                let _ = agent
                    .post(&endpoint)
                    .header("Content-Type", "text/plain")
                    .send(cmd.as_str());
            }
        });
        Self {
            updates,
            input,
            url,
            sender,
            generation: Default::default(),
            frame: Default::default(),
        }
    }

    pub fn list_flows(&self) {
        let url = format!("{}/api/flows", self.url);
        let tx = self.sender.clone();
        thread::spawn(move || {
            let result = ureq::get(url)
                .call()
                .and_then(|mut r| r.body_mut().read_json());
            let _ = tx.send(match result {
                Ok(rows) => Update::Flows(rows),
                Err(e) => Update::Output(format!("× {e}\n")),
            });
        });
    }

    pub fn save_flow(&self, id: String, path: std::path::PathBuf) {
        use std::io::Write;
        let url = format!("{}/api/flows/{id}", self.url);
        let tx = self.sender.clone();
        thread::spawn(move || {
            let write = || -> Result<(), Box<dyn std::error::Error>> {
                let bytes = ureq::get(url).call()?.into_body().read_to_vec()?;
                let mut tmp = tempfile::NamedTempFile::new_in(
                    path.parent().unwrap_or(std::path::Path::new(".")),
                )?;
                tmp.write_all(&bytes)?;
                tmp.persist(&path)?;
                Ok(())
            };
            let msg = match write() {
                Ok(()) => format!("✓ {}\n", path.display()),
                Err(e) => format!("× {e}\n"),
            };
            let _ = tx.send(Update::Output(msg));
        });
    }

    pub fn prompt(&self, prompt: String) {
        self.execute("/api/prompt", move || Ok(json!({"prompt":prompt})));
    }

    pub fn replay(&self, path: std::path::PathBuf, device: Value) {
        self.execute("/api/flows/run", move || {
            let yaml = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            Ok(json!({"yaml":yaml,"device":device}))
        });
    }

    fn execute(&self, route: &str, body: impl FnOnce() -> Result<Value, String> + Send + 'static) {
        let url = format!("{}{route}", self.url);
        let tx = self.sender.clone();
        thread::spawn(move || {
            let reply = || -> Result<(), String> {
                let mut response = ureq::post(&url)
                    .config()
                    .http_status_as_error(false)
                    .build()
                    .header("Accept", "application/x-ndjson")
                    .send_json(body()?)
                    .map_err(|e| e.to_string())?;
                if !response.status().is_success() {
                    let body: Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
                    return Err(body["error"].as_str().unwrap_or("Request failed").into());
                }
                for line in BufReader::new(response.into_body().into_reader()).lines() {
                    let event: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                    let text = event["text"].as_str().unwrap_or_default();
                    match event["kind"].as_str() {
                        Some("done") => return Ok(()),
                        Some("error") => return Err(text.into()),
                        _ => {
                            tx.send(Update::Output(text.into()))
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
                Err("Connection closed before completion.".into())
            };
            let _ = tx.send(Update::Reply(reply()));
        });
    }

    pub fn stream(&self, url: Option<String>) {
        let generation = self.generation.clone();
        let id = generation.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(url) = url else { return };
        let frame = self.frame.clone();
        thread::spawn(move || {
            while generation.load(Ordering::Acquire) == id {
                if let Ok(response) = ureq::get(&url).call() {
                    let mut reader = response.into_body().into_reader();
                    let mut data = Vec::new();
                    let mut chunk = [0; 32768];
                    while generation.load(Ordering::Acquire) == id {
                        let Ok(count) = reader.read(&mut chunk) else {
                            break;
                        };
                        if count == 0 {
                            break;
                        }
                        data.extend_from_slice(&chunk[..count]);
                        while let Some(jpeg) = take_jpeg(&mut data) {
                            if let Ok(image) =
                                image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
                            {
                                let mut pixels = image.into_rgba8();
                                for pixel in pixels.pixels_mut() {
                                    pixel.0.swap(0, 2);
                                }
                                *frame.lock().unwrap() = Some((id, pixels));
                            }
                        }
                        if data.len() > 32 * 1024 * 1024 {
                            break;
                        }
                    }
                }
                thread::sleep(Duration::from_millis(500));
            }
        });
    }

    pub fn next_frame(&self) -> Option<image::RgbaImage> {
        let (id, frame) = self.frame.lock().unwrap().take()?;
        (id == self.generation.load(Ordering::Acquire)).then_some(frame)
    }
}

fn take_jpeg(data: &mut Vec<u8>) -> Option<Vec<u8>> {
    let start = data.windows(2).position(|p| p == [0xff, 0xd8])?;
    let end = start
        + 2
        + data[start + 2..]
            .windows(2)
            .position(|p| p == [0xff, 0xd9])?
        + 2;
    let jpeg = data[start..end].to_vec();
    data.drain(..end);
    Some(jpeg)
}
#[cfg(test)]
mod tests {
    use super::take_jpeg;
    #[test]
    fn partial_frames_and_several_frames_in_one_read() {
        let mut data = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n".to_vec();
        data.extend([0xff, 0xd8, 1, 0xff]);
        assert!(take_jpeg(&mut data).is_none());
        data.extend([0xd9, 13, 10, 0xff, 0xd8, 2, 0xff, 0xd9]);
        assert_eq!(take_jpeg(&mut data), Some(vec![0xff, 0xd8, 1, 0xff, 0xd9]));
        assert_eq!(take_jpeg(&mut data), Some(vec![0xff, 0xd8, 2, 0xff, 0xd9]));
        assert!(data.is_empty());
    }
}
