mod launcher;
mod network;
mod overlay;
mod style;

use gpui::{prelude::*, *};
use gpui_component::{
    Root,
    input::{Input, InputEvent, InputState},
};
use network::{Connection, Update};
use overlay::Overlay;
use serde_json::Value;
use std::{
    cell::Cell,
    collections::BTreeMap,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};
use style::{Assets, Palette, hid, icon, yaml};

struct Viewer {
    conn: Connection,
    rows: BTreeMap<u64, Value>,
    device: Value,
    stream: Option<String>,
    image: Option<Arc<RenderImage>>,
    overlays: Vec<Overlay>,
    running_until: Instant,
    collapsed: bool,
    scroll: ScrollHandle,
    focus: FocusHandle,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    dragging: bool,
    pending_move: Option<String>,
    input: Entity<InputState>,
    busy: bool,
    replaying: bool,
    flow_choices: Vec<Value>,
    terminal: String,
    terminal_scroll: ScrollHandle,
}

impl Viewer {
    fn new(url: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Ask Maestro…"));
        cx.subscribe_in(&input, window, |this, field, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) && !this.busy {
                let prompt = field.read(cx).value().to_string();
                if !prompt.trim().is_empty() {
                    this.busy = true;
                    this.append_output(&format!("$ {}\n", prompt.trim()));
                    this.terminal_scroll.scroll_to_bottom();
                    this.conn.prompt(prompt);
                    cx.notify();
                }
            }
        })
        .detach();
        let focus = cx.focus_handle();
        focus.focus(window);
        cx.spawn_in(window, async move |view, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(16))
                    .await;
                if view
                    .update_in(cx, |viewer, window, cx| viewer.poll(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        Self {
            conn: Connection::new(url),
            rows: BTreeMap::new(),
            device: Value::Null,
            stream: None,
            image: None,
            overlays: Vec::new(),
            running_until: Instant::now(),
            collapsed: false,
            scroll: ScrollHandle::new(),
            focus,
            bounds: Default::default(),
            dragging: false,
            pending_move: None,
            input,
            busy: false,
            replaying: false,
            flow_choices: Vec::new(),
            terminal: String::new(),
            terminal_scroll: ScrollHandle::new(),
        }
    }

    fn poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = !self.overlays.is_empty()
            || Instant::now() < self.running_until + Duration::from_millis(32);
        while let Ok(update) = self.conn.updates.try_recv() {
            changed = true;
            match update {
                Update::State(device) => {
                    let next = device["streamUrl"]
                        .as_str()
                        .filter(|_| device["status"] == "streaming")
                        .map(str::to_owned);
                    if self.stream != next {
                        self.conn.stream(next.clone());
                        if let Some(old) = self.image.take() {
                            cx.drop_image(old, Some(window));
                        }
                        self.stream = next;
                    }
                    self.device = device;
                }
                Update::Event(event) => {
                    if let Some(commands) = event["commands"]
                        .as_array()
                        .filter(|_| event["type"] == "maestro.flow_state")
                    {
                        for cmd in commands {
                            if let Some(id) = cmd["commandId"].as_str().and_then(|s| s.parse().ok())
                            {
                                self.rows.insert(id, cmd.clone());
                            }
                        }
                        if let Some((ix, _)) = self
                            .rows
                            .values()
                            .filter(|r| r["depth"] == 0)
                            .enumerate()
                            .filter(|(_, r)| r["status"] == "started")
                            .last()
                        {
                            self.scroll.scroll_to_item(ix);
                        }
                    }
                    if let Some(o) = Overlay::from_event(&event) {
                        self.overlays.insert(0, o);
                        self.overlays.truncate(8);
                    }
                }
                Update::Flows(rows) => {
                    self.flow_choices.clear();
                    if rows.len() == 1 {
                        self.choose_save(rows[0]["id"].as_str().unwrap_or_default().to_owned(), cx);
                    } else if rows.is_empty() {
                        self.append_output("저장할 성공 동선이 없습니다.\n");
                    } else {
                        self.flow_choices = rows;
                    }
                }
                Update::Output(text) => self.append_output(&text),
                Update::Reply(result) => {
                    self.busy = false;
                    if result.is_ok() && !self.replaying {
                        self.input
                            .update(cx, |field, cx| field.set_value("", window, cx));
                    }
                    self.replaying = false;
                    if let Err(error) = result {
                        self.append_output(&format!("× {error}\n"));
                    }
                }
            }
        }
        self.overlays.retain(Overlay::active);
        if let Some(frame) = self.conn.next_frame() {
            changed = true;
            let new = Arc::new(RenderImage::new(vec![image::Frame::new(frame)]));
            if let Some(old) = self.image.replace(new) {
                cx.drop_image(old, Some(window));
            }
        }
        if let Some(cmd) = self.pending_move.take() {
            let _ = self.conn.input.send(cmd);
        }
        if self.rows.values().any(|r| r["status"] == "started") {
            self.running_until = Instant::now() + Duration::from_millis(600);
        }
        if changed {
            cx.notify();
        }
    }

    fn choose_save(&mut self, id: String, cx: &mut Context<Self>) {
        self.flow_choices.clear();
        let directory = std::env::current_dir().unwrap_or_default();
        let dialog = cx.prompt_for_new_path(&directory, Some("maestro-flow.yaml"));
        cx.spawn(async move |this, cx| {
            let picked = dialog.await;
            let _ = this.update(cx, |s, cx| {
                match picked {
                    Ok(Ok(Some(path))) => s.conn.save_flow(id, path),
                    Ok(Err(e)) => s.append_output(&format!("× {e}\n")),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn choose_run(&mut self, cx: &mut Context<Self>) {
        let dialog = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("파일 열어 실행".into()),
        });
        cx.spawn(async move |this, cx| {
            let picked = dialog.await;
            let _ = this.update(cx, |s, cx| {
                match picked {
                    Ok(Ok(Some(paths))) if !s.busy => {
                        if let Some(path) = paths.into_iter().next() {
                            s.busy = true;
                            s.replaying = true;
                            s.append_output(&format!("▶ {}\n", path.display()));
                            s.conn.replay(path, s.device["deviceId"].clone());
                        }
                    }
                    Ok(Err(e)) => s.append_output(&format!("× {e}\n")),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn append_output(&mut self, text: &str) {
        let follow =
            self.terminal_scroll.max_offset().height + self.terminal_scroll.offset().y < px(24.);
        self.terminal.push_str(text);
        if self.terminal.len() > 120000 {
            let cut = self
                .terminal
                .ceil_char_boundary(self.terminal.len() - 120000);
            self.terminal.drain(..cut);
        }
        if follow {
            self.terminal_scroll.scroll_to_bottom();
        }
    }

    fn touch(&mut self, action: &str, point: Point<Pixels>) {
        let b = self.bounds.get();
        if b.size.width <= px(0.) || b.size.height <= px(0.) {
            return;
        }
        let x = ((point.x - b.left()) / b.size.width).clamp(0., 1.);
        let y = ((point.y - b.top()) / b.size.height).clamp(0., 1.);
        let cmd = format!("touch {action} {x},{y}");
        if action == "Move" {
            self.pending_move = Some(cmd);
        } else {
            if let Some(pending) = self.pending_move.take() {
                let _ = self.conn.input.send(pending);
            }
            let _ = self.conn.input.send(cmd);
        }
    }

    fn commands(&self, p: Palette, cx: &Context<Self>) -> Div {
        let panel = div()
            .my_2()
            .mx_2()
            .flex()
            .flex_col()
            .rounded_xl()
            .border_1()
            .border_color(p.border())
            .bg(p.panel())
            .shadow_lg()
            .overflow_hidden();
        let toggle_label = if self.collapsed {
            "Expand Maestro MCP"
        } else {
            "Collapse Maestro MCP"
        };
        let toggle = div()
            .id("toggle")
            .tooltip(move |w, cx| gpui_component::tooltip::Tooltip::new(toggle_label).build(w, cx))
            .cursor_pointer()
            .size_6()
            .rounded_sm()
            .flex()
            .items_center()
            .justify_center()
            .hover(move |s| s.bg(p.border()))
            .child(icon(
                if self.collapsed { "expand" } else { "collapse" },
                14.,
                p.text(),
            ))
            .on_click(cx.listener(|s, _, _, cx| {
                s.collapsed = !s.collapsed;
                cx.notify();
            }));
        if self.collapsed {
            return panel
                .w_10()
                .items_center()
                .gap_2()
                .py_2()
                .child(toggle)
                .child(icon("maestro", 16., p.text()))
                .child(icon_label(p));
        }
        let clear = div()
            .id("clear")
            .tooltip(|w, cx| gpui_component::tooltip::Tooltip::new("Clear log").build(w, cx))
            .size_6()
            .flex()
            .items_center()
            .justify_center()
            .rounded_sm()
            .when(!self.rows.is_empty(), |d| {
                d.cursor_pointer().hover(move |s| s.bg(p.border()))
            })
            .child(icon(
                "clear",
                14.,
                if self.rows.is_empty() {
                    p.muted()
                } else {
                    p.text()
                },
            ))
            .on_click(cx.listener(|s, _, _, cx| {
                s.rows.clear();
                cx.notify();
            }));
        let header = div()
            .h_8()
            .flex_none()
            .flex()
            .items_center()
            .justify_between()
            .px_2()
            .border_b_1()
            .border_color(p.border())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(icon("maestro", 14., p.text()))
                    .child("Maestro MCP"),
            )
            .child(div().flex().child(clear).child(toggle));
        let rows: Vec<_> = self.rows.values().filter(|r| r["depth"] == 0).collect();
        let empty = rows.is_empty();
        let mut list = div()
            .id("commands")
            .track_scroll(&self.scroll)
            .flex_1()
            .overflow_y_scroll()
            .px_2()
            .pt_2()
            .pb_8();
        for (i, row) in rows.iter().enumerate() {
            let status = row["status"].as_str().unwrap_or("pending");
            let color = p.status(status);
            let mut glyph = icon(status, 14., color);
            if status == "started" {
                let phase = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_millis() as f32
                    / 1000.;
                glyph = glyph.with_transformation(Transformation::rotate(radians(
                    phase * std::f32::consts::TAU,
                )));
            }
            let line_color = if status == "started" {
                p.muted()
            } else {
                color
            };
            let marker = div()
                .relative()
                .flex_none()
                .w(px(14.))
                .pt(px(2.))
                .child(glyph)
                .when(i + 1 < rows.len(), |d| {
                    d.child(
                        div()
                            .absolute()
                            .left(px(6.))
                            .w(px(2.))
                            .top(px(16.))
                            .when(status == "started", |d| d.top(relative(1.)))
                            .bottom(px(-10.))
                            .bg(linear_gradient(
                                180.,
                                linear_color_stop(line_color.opacity(0.6), 0.),
                                linear_color_stop(line_color.opacity(0.2), 1.),
                            )),
                    )
                });
            let content = div()
                .min_w_0()
                .flex_1()
                .child(
                    div()
                        .id(("yaml", i))
                        .line_height(px(20.))
                        .overflow_x_scroll()
                        .whitespace_nowrap()
                        .font_family("JetBrains Mono")
                        .child(yaml(row["yaml"].as_str().unwrap_or(""), p)),
                )
                .when(status == "failed", |d| {
                    d.child(
                        div()
                            .text_color(p.status("failed"))
                            .child(row["errorMessage"].as_str().unwrap_or("").to_owned()),
                    )
                });
            list = list.child(
                div()
                    .flex()
                    .when(i > 0, |d| d.mt_1())
                    .gap_2()
                    .px_1p5()
                    .py(px(2.))
                    .rounded_xl()
                    .when(status == "started", |d| {
                        d.bg(p.color(0xbae6fd, 0x0c4a6e))
                            .border_2()
                            .border_color(color)
                    })
                    .child(marker)
                    .child(content),
            );
        }
        panel
            .flex_1()
            .min_w(px(320.))
            .ml_6()
            .child(header)
            .child(if empty {
                div()
                    .px_3()
                    .pt_2()
                    .text_color(p.muted())
                    .child("Commands executed by Maestro MCP")
                    .into_any_element()
            } else {
                list.into_any_element()
            })
    }

    fn device(&self, height: f32, max_width: f32, p: Palette, cx: &Context<Self>) -> Div {
        let live = self.stream.is_some();
        let aspect = self
            .image
            .as_ref()
            .map(|im| {
                let s = im.size(0);
                s.width.0 as f32 / s.height.0 as f32
            })
            .unwrap_or(9. / 19.);
        let height = height.min(max_width / aspect);
        let frame = div()
            .relative()
            .flex_none()
            .w(px(height * aspect))
            .h(px(height))
            .rounded(px(32.))
            .overflow_hidden();
        let mut pane = div().flex().items_start().gap_4().p_4();
        if !live {
            return pane.child(
                frame
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap_3()
                    .px_6()
                    .text_center()
                    .bg(p.panel())
                    .border_2()
                    .border_dashed()
                    .border_color(p.color(0xd4d4d4, 0x404040))
                    .child(icon("device", 40., p.muted()))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child("No device connected"),
                    )
                    .when_some(self.device["message"].as_str(), |d, msg| {
                        d.child(div().max_w(px(240.)).child(msg.to_owned()))
                    }),
            );
        }
        let bounds = self.bounds.clone();
        let overlays = self.overlays.clone();
        let frame = frame
            .bg(rgb(0x171717))
            .shadow_xl()
            .when(Instant::now() < self.running_until, |d| {
                d.shadow(vec![
                    BoxShadow {
                        color: p.color(0x0ea5e9, 0x38bdf8),
                        offset: point(px(0.), px(0.)),
                        blur_radius: px(0.),
                        spread_radius: px(4.),
                    },
                    BoxShadow {
                        color: black().opacity(0.15),
                        offset: point(px(0.), px(8.)),
                        blur_radius: px(18.),
                        spread_radius: px(0.),
                    },
                ])
            })
            .when_some(self.image.clone(), |d, image| {
                d.child(img(image).size_full().rounded(px(32.)))
            })
            .child(
                canvas(
                    move |b, _, _| bounds.set(b),
                    move |b, _, window, _| {
                        for o in &overlays {
                            o.paint(b, window);
                        }
                    },
                )
                .absolute()
                .inset_0()
                .size_full(),
            )
            .children(
                self.overlays
                    .iter()
                    .filter_map(|o| o.label.clone())
                    .map(|label| {
                        div()
                            .absolute()
                            .bottom_8()
                            .w_full()
                            .flex()
                            .justify_center()
                            .child(
                                div()
                                    .rounded_full()
                                    .px_3()
                                    .py_1()
                                    .bg(rgb(0xfb64b6))
                                    .text_color(white())
                                    .child(label),
                            )
                    }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, e: &MouseDownEvent, w, _| {
                    s.focus.focus(w);
                    s.dragging = true;
                    s.touch("Down", e.position);
                }),
            );
        pane = pane.child(frame);
        let platform = self.device["platform"].as_str().unwrap_or("");
        if !matches!(platform, "android" | "ios") {
            return pane;
        }
        let mut rail = div()
            .flex()
            .flex_col()
            .p_1p5()
            .gap_1p5()
            .rounded_lg()
            .border_1()
            .border_color(p.border())
            .bg(p.panel())
            .shadow_sm();
        for name in [
            "power",
            "volumeUp",
            "volumeDown",
            "back",
            "home",
            "appSwitch",
        ] {
            if name == "back" && platform == "ios" {
                continue;
            }
            if name == "home" && platform == "ios" || name == "back" {
                rail = rail.child(div().my_1().h_px().bg(p.border()));
            }
            rail = rail.child(
                div()
                    .id(name)
                    .tooltip(move |w, cx| {
                        gpui_component::tooltip::Tooltip::new(match name {
                            "power" => "Power",
                            "volumeUp" => "Volume up",
                            "volumeDown" => "Volume down",
                            "back" => "Back",
                            "home" => "Home",
                            _ => "Recents",
                        })
                        .build(w, cx)
                    })
                    .size_8()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_md()
                    .border_1()
                    .border_color(p.border())
                    .bg(p.panel())
                    .cursor_pointer()
                    .hover(move |s| s.bg(p.border()))
                    .shadow_sm()
                    .child(icon(name, 16., p.text()))
                    .on_click(cx.listener(move |s, _, w, _| {
                        s.focus.focus(w);
                        let tx = s.conn.input.clone();
                        let _ = tx.send(format!("button Down {name}"));
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(80));
                            let _ = tx.send(format!("button Up {name}"));
                        });
                    })),
            );
        }
        pane.child(rail)
    }
}

fn icon_label(p: Palette) -> Svg {
    svg()
        .path("vertical.svg")
        .w(px(14.))
        .h(px(87.))
        .text_color(p.text())
}

impl Render for Viewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette(matches!(
            window.appearance(),
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        ));
        let height = (f32::from(window.viewport_size().height) - 64.).max(64.);
        let width = (f32::from(window.viewport_size().width) * 0.24).clamp(216., 320.);
        let commands_width = if self.collapsed { 40. } else { 320. };
        let rail = if self.stream.is_some() { 64. } else { 0. };
        let phone_width = (f32::from(window.viewport_size().width).min(1392.)
            - width
            - commands_width
            - 64.
            - rail)
            .max(140.);
        let sidebar = div()
            .flex_none()
            .w(px(width))
            .pl_4()
            .py_2()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                Input::new(&self.input)
                    .disabled(self.busy)
                    .h(px(36.))
                    .rounded_lg(),
            )
            .child(
                div().flex().gap_1().children(
                    ["성공 동선 저장", "파일 열어 실행"]
                        .into_iter()
                        .enumerate()
                        .map(|(i, label)| {
                            div()
                                .id(("flow-action", i))
                                .rounded_md()
                                .border_1()
                                .border_color(p.border())
                                .px_2()
                                .py_1()
                                .text_xs()
                                .child(label)
                                .when(!self.busy, |d| {
                                    d.cursor_pointer().on_click(cx.listener(move |s, _, _, cx| {
                                        if i == 0 {
                                            s.conn.list_flows();
                                        } else {
                                            s.choose_run(cx);
                                        }
                                    }))
                                })
                        }),
                ),
            )
            .when(!self.flow_choices.is_empty(), |d| {
                d.child(
                    div()
                        .id("flow-choices")
                        .max_h(px(150.))
                        .overflow_y_scroll()
                        .children(self.flow_choices.iter().enumerate().map(|(i, r)| {
                            let id = r["id"].as_str().unwrap_or_default().to_owned();
                            div()
                                .id(("saved-flow", i))
                                .px_2()
                                .py_1()
                                .cursor_pointer()
                                .child(format!(
                                    "{} · {} · {}회",
                                    r["label"].as_str().unwrap_or(""),
                                    r["device"].as_str().unwrap_or(""),
                                    r["count"]
                                ))
                                .on_click(
                                    cx.listener(move |s, _, _, cx| s.choose_save(id.clone(), cx)),
                                )
                        })),
                )
            })
            .child(
                div()
                    .id("terminal")
                    .track_scroll(&self.terminal_scroll)
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .bg(rgb(0xffffff))
                    .border_1()
                    .border_color(rgb(0xe5e5e5))
                    .rounded_xl()
                    .p_3()
                    .font_family("JetBrains Mono")
                    .text_xs()
                    .line_height(px(20.))
                    .text_color(rgb(0x262626))
                    .child(self.terminal.clone()),
            );
        let input_focus = self.input.focus_handle(cx);
        let keyboard = move |s: &Viewer, key: &Keystroke, action: &str, w: &Window| {
            if !input_focus.is_focused(w)
                && let Some(code) = hid(key)
            {
                let _ = s.conn.input.send(format!("key {action} {code}"));
            }
        };
        let keyup = keyboard.clone();
        div()
            .size_full()
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .items_center()
            .bg(p.background())
            .text_color(p.text())
            .text_xs()
            .font_family("Inter")
            .on_key_down(
                cx.listener(move |s, e: &KeyDownEvent, w, _| keyboard(s, &e.keystroke, "Down", w)),
            )
            .on_key_up(cx.listener(move |s, e: &KeyUpEvent, w, _| keyup(s, &e.keystroke, "Up", w)))
            .on_mouse_move(cx.listener(|s, e: &MouseMoveEvent, _, _| {
                if s.dragging {
                    s.touch("Move", e.position)
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|s, e: &MouseUpEvent, _, _| {
                    if s.dragging {
                        s.dragging = false;
                        s.touch("Up", e.position)
                    }
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|s, e: &MouseUpEvent, _, _| {
                    if s.dragging {
                        s.dragging = false;
                        s.touch("Up", e.position)
                    }
                }),
            )
            .child(
                div()
                    .flex_1()
                    .w_full()
                    .flex()
                    .justify_center()
                    .items_center()
                    .child(
                        div()
                            .flex()
                            .max_w(px(1392.))
                            .h(px(height + 32.))
                            .w_full()
                            .child(sidebar)
                            .child(self.commands(p, cx))
                            .child(self.device(height, phone_width, p, cx)),
                    ),
            )
    }
}

fn main() {
    let (_bridge, url) = match std::env::args().nth(1) {
        Some(url) => (None, url),
        None => {
            let (bridge, url) = launcher::Bridge::start().expect("Start Maestro MCP bridge");
            (Some(bridge), url)
        }
    };
    Application::new().with_assets(Assets).run(move |cx| {
        gpui_component::init(cx);
        cx.text_system()
            .add_fonts(
                ["inter.ttf", "mono.ttf"]
                    .iter()
                    .filter_map(|path| Assets::get(path).map(|asset| asset.data))
                    .collect(),
            )
            .expect("Load Viewer fonts");
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit()
            }
        })
        .detach();
        let bounds = Bounds::centered(None, size(px(1280.), px(760.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Maestro Viewer".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| {
                let view = cx.new(|cx| Viewer::new(url, window, cx));
                cx.new(|cx| Root::new(view, window, cx))
            },
        )
        .expect("Open Maestro Viewer");
        cx.activate(true);
    });
}
