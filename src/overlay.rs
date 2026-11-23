use gpui::*;
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Overlay {
    kind: String,
    start: (f32, f32),
    end: (f32, f32),
    pub label: Option<String>,
    time: Instant,
    duration: Duration,
}

impl Overlay {
    pub fn from_event(event: &Value) -> Option<Self> {
        if event["status"] != "started" {
            return None;
        }
        let kind = event["type"].as_str()?;
        let (from, to, ms, label) = match kind {
            "driver.tap" => ("point", "point", 200, None),
            "driver.swipe" => ("start", "end", event["durationMs"].as_u64()?, None),
            "driver.input_text" => (
                "",
                "",
                1200,
                Some(format!("input text · {} chars", event["textLength"])),
            ),
            _ => return None,
        };
        let coords = |key: &str| {
            let n = |axis: &str| event[key][axis].as_f64().unwrap_or(0.).clamp(0., 1.) as f32;
            (n("x"), n("y"))
        };
        Some(Self {
            kind: kind.into(),
            start: coords(from),
            end: coords(to),
            label,
            time: Instant::now(),
            duration: Duration::from_millis(ms.max(1)),
        })
    }
    pub fn active(&self) -> bool {
        self.time.elapsed() < self.duration
    }
    pub fn paint(&self, b: Bounds<Pixels>, win: &mut Window) {
        if self.label.is_some() || !self.active() {
            return;
        }
        let t = (self.time.elapsed().as_secs_f32() / self.duration.as_secs_f32()).min(1.);
        let pos =
            |(x, y): (f32, f32)| point(b.left() + b.size.width * x, b.top() + b.size.height * y);
        let a = pos(self.start);
        let pink = rgb(0xfb64b6);
        let circle = |p: Point<Pixels>, r: f32, win: &mut Window| {
            win.paint_quad(quad(
                Bounds::new(
                    point(p.x - px(r), p.y - px(r)),
                    size(px(2. * r), px(2. * r)),
                ),
                px(r),
                pink,
                px(0.),
                transparent_black(),
                BorderStyle::Solid,
            ))
        };
        if self.kind == "driver.tap" {
            circle(a, 17.5 + 15. * t, win);
            return;
        }
        let end = pos(self.end);
        let tip = a + (end - a) * t;
        let mut path = PathBuilder::stroke(px(40.));
        path.move_to(a);
        path.line_to(tip);
        if let Ok(path) = path.build() {
            win.paint_path(path, pink);
        }
        circle(a, 20., win);
        circle(tip, 20., win);
    }
}
