use gpui::*;
use std::borrow::Cow;

#[derive(rust_embed::RustEmbed)]
#[folder = "assets/"]
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(Self::get(path).map(|asset| asset.data))
    }
    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(Self::iter()
            .filter(|name| name.starts_with(path))
            .map(|name| name.into_owned().into())
            .collect())
    }
}

#[derive(Clone, Copy)]
pub struct Palette(pub bool);
impl Palette {
    pub fn color(self, light: u32, dark: u32) -> Hsla {
        rgb(if self.0 { dark } else { light }).into()
    }
    pub fn background(self) -> Hsla {
        self.color(0xf5f5f5, 0x0a0a0a)
    }
    pub fn panel(self) -> Hsla {
        self.color(0xf9f9f9, 0x171717)
    }
    pub fn border(self) -> Hsla {
        self.color(0xe5e5e5, 0x262626)
    }
    pub fn text(self) -> Hsla {
        self.color(0x404040, 0xe5e5e5)
    }
    pub fn muted(self) -> Hsla {
        self.color(0xa3a3a3, 0x737373)
    }
    pub fn status(self, status: &str) -> Hsla {
        match status {
            "completed" => rgb(0x10b981).into(),
            "failed" => rgb(0xef4444).into(),
            "warned" => rgb(0xf59e0b).into(),
            "started" => self.color(0x0369a1, 0x38bdf8),
            _ => self.muted(),
        }
    }
}

pub fn icon(name: &str, size: f32, color: Hsla) -> Svg {
    svg()
        .path(format!("{name}.svg"))
        .size(px(size))
        .text_color(color)
        .flex_none()
}

pub fn status_chip(label: &str, p: Palette) -> Div {
    let (fg, bg) = match label {
        "진행 중" | "실행 중" => (p.color(0x4338ca, 0xc7c5ff), p.color(0xeef2ff, 0x302e57)),
        "완료" | "양호" => (p.color(0x116145, 0x9ae6c5), p.color(0xe3f6eb, 0x15392f)),
        "취약" | "중단" | "실패" => {
            (p.color(0x9d2437, 0xffb9c1), p.color(0xffe9eb, 0x502731))
        }
        "판단 보류" => (p.color(0x854900, 0xffdc9a), p.color(0xfff2d5, 0x483514)),
        _ => (p.color(0x52525b, 0xd4d4d8), p.color(0xf1f2f4, 0x303039)),
    };
    let pill = div()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(5.))
        .rounded_full()
        .px(px(8.))
        .py(px(3.))
        .bg(bg)
        .text_color(fg)
        .text_size(px(11.))
        .line_height(px(15.))
        .font_weight(FontWeight::SEMIBOLD);
    let pill = if matches!(label, "진행 중" | "실행 중") {
        pill.child(icon("started", 12., fg).with_animation(
            "status-spin",
            Animation::new(std::time::Duration::from_millis(900)).repeat(),
            |glyph, phase| {
                glyph.with_transformation(Transformation::rotate(radians(
                    phase * std::f32::consts::TAU,
                )))
            },
        ))
    } else {
        pill.child(div().size(px(6.)).rounded_full().bg(fg))
    };
    pill.child(label.to_owned())
}

pub fn yaml(text: &str, p: Palette) -> StyledText {
    use regex::Regex;
    use std::sync::LazyLock;
    static KEY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*([A-Za-z_][A-Za-z0-9_]*)(:|\s*$)").unwrap());
    static VALUE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"^\s*(?:("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?))"#).unwrap());
    let mut out = String::new();
    let mut highlights = Vec::new();
    let style = |color, weight| HighlightStyle {
        color: Some(color),
        font_weight: Some(weight),
        ..Default::default()
    };
    for (i, line) in text.split('\n').enumerate() {
        out.push_str(if i == 0 { "- " } else { "\n  " });
        let base = out.len();
        out.push_str(line);
        let mut value_start = 0;
        if let Some(parts) = KEY.captures(line) {
            let key = parts.get(1).unwrap();
            highlights.push((
                base + key.start()..base + key.end(),
                style(p.color(0x4338ca, 0xa5b4fc), FontWeight::SEMIBOLD),
            ));
            let delimiter = parts.get(2).unwrap();
            if delimiter.as_str() != ":" {
                continue;
            }
            highlights.push((
                base + delimiter.start()..base + delimiter.end(),
                style(p.muted(), FontWeight::LIGHT),
            ));
            value_start = delimiter.end();
        }
        if let Some(parts) = VALUE.captures(&line[value_start..]) {
            let (token, color) = if let Some(string) = parts.get(1) {
                (string, p.color(0x047857, 0x34d399))
            } else {
                (parts.get(2).unwrap(), p.color(0x6d28d9, 0xa78bfa))
            };
            let start = base + value_start;
            highlights.push((
                start + token.start()..start + token.end(),
                style(color, FontWeight::LIGHT),
            ));
        }
    }
    StyledText::new(out).with_highlights(highlights)
}

pub fn hid(key: &Keystroke) -> Option<u8> {
    if key.modifiers.platform || key.modifiers.control {
        return None;
    }
    let k = key.key.to_ascii_lowercase();
    if k.len() == 1 && k.as_bytes()[0].is_ascii_lowercase() {
        return Some(4 + k.as_bytes()[0] - b'a');
    }
    if k.len() == 1 && matches!(k.as_bytes()[0], b'1'..=b'9') {
        return Some(30 + k.as_bytes()[0] - b'1');
    }
    Some(match k.as_str() {
        "0" => 39,
        "hangul" | "hangulmode" | "lang1" => 144,
        "enter" => 40,
        "escape" => 41,
        "backspace" => 42,
        "tab" => 43,
        "space" | " " => 44,
        "-" => 45,
        "=" => 46,
        "[" => 47,
        "]" => 48,
        "\\" => 49,
        ";" => 51,
        "'" => 52,
        "`" => 53,
        "," => 54,
        "." => 55,
        "/" => 56,
        "right" => 79,
        "left" => 80,
        "down" => 81,
        "up" => 82,
        _ => return None,
    })
}
