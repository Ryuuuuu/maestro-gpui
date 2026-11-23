use super::*;
use gpui_component::{
    Disableable, Sizable,
    button::Button,
    menu::{DropdownMenu, PopupMenuItem},
};

impl Viewer {
    fn send_traffic(&mut self, action: String, cx: &mut Context<Self>) {
        self.traffic_pending = true;
        self.traffic_message.clear();
        self.conn.traffic_action(action);
        cx.notify();
    }

    pub fn proxy_toggle(&self, cx: &Context<Self>) -> Button {
        let on = self.traffic["state"] == "on";
        let id = self.device["deviceId"].as_str().unwrap_or("");
        let action = if on {
            "off".to_owned()
        } else {
            format!("on/{id}")
        };
        Button::new("proxy-toggle")
            .small()
            .label(if on {
                "● 프록시 ON"
            } else {
                "○ 프록시 OFF"
            })
            .tooltip(if on {
                format!("127.0.0.1:{}", self.traffic["port"])
            } else {
                "선택한 기기의 통신 기록".into()
            })
            .disabled(self.traffic_pending || self.traffic.is_null() || (!on && id.is_empty()))
            .on_click(cx.listener(move |s, _, _, cx| s.send_traffic(action.clone(), cx)))
    }

    pub fn traffic_panel(&self, p: Palette, cx: &Context<Self>) -> Div {
        let runs = self.traffic["runs"].as_array().cloned().unwrap_or_default();
        let id = self.traffic["selected"].as_str().unwrap_or("").to_owned();
        let selected = self.traffic["runs"]
            .as_array()
            .and_then(|list| list.iter().find(|r| r["id"] == id));
        let count = selected.and_then(|r| r["count"].as_u64()).unwrap_or(0);
        let status = selected.and_then(|r| r["status"].as_str()).unwrap_or("");
        let save = format!("save/{id}");
        let mut card = div()
            .min_h_0()
            .max_h(px(250.))
            .flex()
            .flex_col()
            .gap_1()
            .p_2()
            .rounded_xl()
            .border_1()
            .border_color(p.border())
            .bg(p.panel())
            .text_xs()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("통신 기록"))
                    .child(
                        Button::new("traffic-save")
                            .small()
                            .label("파일 저장")
                            .disabled(count == 0 || status == "수집 중" || self.traffic_pending)
                            .on_click(
                                cx.listener(move |s, _, _, cx| s.send_traffic(save.clone(), cx)),
                            ),
                    ),
            );
        if let Some(run) = selected {
            let selection = self.conn.traffic_selection.clone();
            let label = run["label"].as_str().unwrap_or("");
            card = card
                .child(
                    Button::new("traffic-runs")
                        .small()
                        .label(format!("{} ▾", label.chars().take(30).collect::<String>()))
                        .dropdown_menu_with_anchor(Corner::TopLeft, move |mut menu, _, _| {
                            for (key, text) in
                                std::iter::once((String::new(), "최근 실행".to_owned())).chain(
                                    runs.iter().map(|r| {
                                        (
                                            r["id"].as_str().unwrap_or("").to_owned(),
                                            r["label"].as_str().unwrap_or("").to_owned(),
                                        )
                                    }),
                                )
                            {
                                let selection = selection.clone();
                                menu =
                                    menu.item(PopupMenuItem::new(text).on_click(move |_, _, _| {
                                        *selection.lock().unwrap() = (key.clone(), 0);
                                    }));
                            }
                            menu
                        }),
                )
                .child(format!("{status} · {count}건"));
        }
        let mut rows = div().id("traffic-rows").min_h_0().overflow_y_scroll();
        if count == 0 {
            rows = rows.child(if selected.is_some() {
                "이 실행에 기록된 통신이 없습니다."
            } else if self.traffic["state"] == "on" {
                "동선을 실행하면 통신이 표시됩니다."
            } else {
                "상단에서 프록시를 켜고 동선을 실행하세요."
            });
        }
        for row in self.traffic["rows"].as_array().into_iter().flatten() {
            let method = row["method"].as_str().unwrap_or("");
            let endpoint = format!("{}:{}", row["host"].as_str().unwrap_or(""), row["port"]);
            let result = if row["error"] == true {
                "오류".into()
            } else {
                row["status"]
                    .as_u64()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "—".into())
            };
            let path = if method == "CONNECT" {
                "HTTPS 연결"
            } else {
                row["path"].as_str().unwrap_or("")
            };
            let bytes = row["bytes"]
                .as_u64()
                .map(|n| format!(" · {n} B"))
                .unwrap_or_default();
            let index = row["index"].as_u64().unwrap_or(0) as usize;
            let key = format!("{id}/{index}");
            let detail = self
                .traffic_detail
                .as_ref()
                .filter(|(open, _)| *open == key);
            rows = rows.child(
                div()
                    .id(("traffic-entry", index))
                    .cursor_pointer()
                    .py_1()
                    .border_b_1()
                    .border_color(p.border())
                    .child(format!("{method}  {endpoint}  {result}"))
                    .child(div().text_color(p.muted()).child(format!("{path}{bytes}")))
                    .when_some(detail, |d, (_, text)| {
                        d.child(div().font_family("JetBrains Mono").child(text.clone()))
                    })
                    .on_click(cx.listener(move |s, _, _, cx| {
                        if s.traffic_detail
                            .as_ref()
                            .is_some_and(|(open, _)| open == &key)
                        {
                            s.traffic_detail = None;
                        } else {
                            s.traffic_detail = Some((key.clone(), "불러오는 중…".into()));
                            s.conn.traffic_detail(key.clone());
                        }
                        cx.notify();
                    })),
            );
        }
        card = card.child(rows);
        let pages = self.traffic["pages"].as_u64().unwrap_or(1) as usize;
        let page = self.traffic["page"].as_u64().unwrap_or(0) as usize;
        if pages > 1 {
            let button = |label: &'static str, next, disabled| {
                Button::new(label)
                    .small()
                    .label(label)
                    .disabled(disabled)
                    .on_click(cx.listener(move |s, _, _, _| {
                        s.conn.traffic_selection.lock().unwrap().1 = next
                    }))
            };
            card = card.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(button("이전", page.saturating_sub(1), page == 0))
                    .child(format!("{} / {pages}", page + 1))
                    .child(button("다음", page + 1, page + 1 >= pages)),
            );
        }
        if self.traffic["platform"] == "ios" && self.traffic["state"] == "on" {
            card = card.child(format!(
                "테스트 클라이언트 프록시 · 127.0.0.1:{}",
                self.traffic["port"]
            ));
        }
        let msg = if self.traffic_message.is_empty() {
            self.traffic["message"].as_str().unwrap_or("")
        } else {
            &self.traffic_message
        };
        if !msg.is_empty() {
            card = card.child(msg.to_owned());
        }
        card
    }
}
