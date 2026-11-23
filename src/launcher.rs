use std::{
    io::{self, BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
};

/// The bridge owns the MCP process. Closing its stdin lets both stop gracefully.
pub struct Bridge(Child);

impl Bridge {
    pub fn start() -> io::Result<(Self, String)> {
        let exe = std::env::current_exe()?;
        let root = exe
            .ancestors()
            .find(|dir| dir.join("server/main.js").is_file())
            .unwrap_or(Path::new(env!("CARGO_MANIFEST_DIR")));
        let mut child = Command::new("node")
            .args(["server/main.js", "--native"])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line)?;
        let bridge = Self(child);
        let url = line.trim();
        if !url.starts_with("http://127.0.0.1:") {
            return Err(io::Error::other(
                "Maestro startup failed. Check Java, MAESTRO_BIN and the Node dependencies.",
            ));
        }
        Ok((bridge, url.to_owned()))
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        let _ = self.0.wait();
    }
}
