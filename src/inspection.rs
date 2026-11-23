use super::{Palette, Viewer, style::status_chip};
use gpui::{prelude::*, *};
use gpui_component::scroll::ScrollableElement;
use gpui_component::{Disableable, checkbox::Checkbox};
use serde_json::Value;
#[derive(serde::Deserialize)]
pub struct Snapshot {
    run: Option<EngineRun>,
    history: Vec<History>,
}
#[derive(serde::Deserialize)]
struct EngineRun {
    selected: Vec<usize>,
    files: Vec<String>,
    current: Option<usize>,
    results: Vec<String>,
    log: Vec<Entry>,
    status: String,
}
#[derive(serde::Deserialize)]
struct Entry {
    time: String,
    text: String,
}
#[derive(serde::Deserialize)]
struct History {
    finished: String,
    rows: Vec<String>,
    status: String,
}

pub(super) struct Checklist {
    table_scroll: ScrollHandle,
    items: Vec<Value>,
    history: Vec<History>,
    selected: Vec<usize>,
    locked: bool,
    running: bool,
    failed: bool,
    current: Option<usize>,
    pub(super) error: String,
    pub(super) pending: bool,
    results: Vec<String>,
    log: Vec<(String, String)>,
}

impl Checklist {
    pub fn new() -> Self {
        let items: Vec<Value> = serde_json::from_str(include_str!("../assets/inspection.json"))
            .expect("inspection catalog");
        Self {
            selected: (0..items.len()).collect(),
            items,
            table_scroll: ScrollHandle::new(),
            history: vec![],
            locked: false,
            running: false,
            failed: false,
            current: None,
            error: String::new(),
            pending: false,
            results: vec![],
            log: vec![],
        }
    }

    fn name(&self, index: usize) -> &str {
        self.items[index]["name"].as_str().unwrap_or_default()
    }

    pub(super) fn apply(
        &mut self,
        snapshot: Snapshot,
        files: &mut std::collections::BTreeSet<String>,
    ) {
        self.history = snapshot.history;
        self.locked = snapshot.run.is_some();
        self.failed = snapshot.run.as_ref().is_some_and(|r| r.status == "failed");
        if let Some(run) = snapshot.run {
            self.running = run.status == "running";
            self.selected = run.selected;
            self.results = run.results;
            self.current = run.current;
            *files = run.files.into_iter().collect();
            self.log = run
                .log
                .into_iter()
                .map(|e| (format!("+{}", e.time), e.text))
                .collect();
        } else {
            self.results.clear();
            self.current = None;
            self.log.clear();
            self.running = false;
        }
    }
}

impl Viewer {
    pub(super) fn inspection_history(&self, p: Palette) -> Div {
        let history = &self.checklist.history;
        div()
            .flex_1()
            .flex()
            .flex_col()
            .ml_4()
            .my_2()
            .border_1()
            .border_color(p.border())
            .rounded_xl()
            .bg(p.panel())
            .child(
                div()
                    .flex()
                    .justify_between()
                    .p_3()
                    .border_b_1()
                    .border_color(p.border())
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("점검 이력"),
                    )
                    .child(format!("{}건", history.len())),
            )
            .child(
                div()
                    .id("inspection-history")
                    .flex_1()
                    .overflow_y_scroll()
                    .p_3()
                    .when(history.is_empty(), |d| {
                        d.child("아직 완료한 점검이 없습니다.")
                    })
                    .children(history.iter().map(|entry| {
                        div()
                            .mb_3()
                            .rounded_lg()
                            .border_1()
                            .border_color(p.border())
                            .overflow_hidden()
                            .child(
                                div()
                                    .px_3()
                                    .py_2()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .bg(p.background())
                                    .child(
                                        div()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(format!("{} · 모의 점검", entry.finished)),
                                    )
                                    .child(status_chip(
                                        if entry.status == "failed" {
                                            "중단"
                                        } else {
                                            "완료"
                                        },
                                        p,
                                    )),
                            )
                            .children(entry.rows.iter().map(|row| {
                                let line = div()
                                    .px_3()
                                    .py_1()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .border_t_1()
                                    .border_color(p.border());
                                match row.rsplit_once(" · ") {
                                    Some((label, result)) => {
                                        line.child(label.to_owned()).child(status_chip(result, p))
                                    }
                                    None => line.child(row.clone()),
                                }
                            }))
                    })),
            )
    }

    pub(super) fn inspection_panels(&self, p: Palette, cx: &Context<Self>) -> Div {
        let run = &self.checklist;
        let done = run.results.len();
        let total = run.selected.len();
        let active = run.running;
        let border = p.border();
        let card = || {
            div()
                .flex()
                .flex_col()
                .min_h_0()
                .min_w_0()
                .rounded_xl()
                .border_1()
                .border_color(border)
                .bg(p.color(0xffffff, 0x171717))
                .overflow_hidden()
        };
        let header = |title: &'static str, detail: String| {
            div()
                .flex()
                .items_center()
                .flex_none()
                .justify_between()
                .p_3()
                .border_b_1()
                .border_color(border)
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title),
                )
                .child(div().text_color(p.muted()).child(detail))
        };
        let journal = card()
            .w(relative(0.28))
            .max_w(px(320.))
            .min_w(px(130.))
            .child(header(
                "점검 실행 로그",
                format!("모의 엔진 · {}건", run.log.len()),
            ))
            .child(
                div()
                    .id("inspection-journal")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_3()
                    .when(run.log.is_empty(), |d| {
                        d.child("점검을 시작하면 기록이 표시됩니다.")
                    })
                    .children(run.log.iter().rev().map(|(time, text)| {
                        div()
                            .flex()
                            .gap_2()
                            .py_2()
                            .border_b_1()
                            .border_color(border)
                            .child(
                                div()
                                    .font_family("JetBrains Mono")
                                    .text_color(p.muted())
                                    .child(time.clone()),
                            )
                            .child(text.clone())
                    })),
            );
        let row = || {
            div()
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(border)
        };
        let cell = |text: String| div().w(px(70.)).flex_none().child(text);
        let columns = row()
            .flex_none()
            .child(div().w(px(16.)).flex_none())
            .bg(p.panel())
            .child(div().flex_1().child("점검 항목"))
            .child(cell("상태".into()))
            .child(cell("결과".into()));
        let mut table = div()
            .id("inspection-table")
            .track_scroll(&run.table_scroll)
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        for (i, item) in run.items.iter().enumerate() {
            let position = run.selected.iter().position(|&item| item == i);
            let current = active && run.current == Some(i);
            table = table.child(
                row()
                    .when(current, |d| d.bg(p.color(0xeef2ff, 0x292842)))
                    .child(
                        Checkbox::new(("inspection-choice", i))
                            .checked(position.is_some())
                            .disabled(run.locked)
                            .on_click(cx.listener(move |s, checked: &bool, _, cx| {
                                if s.checklist.locked {
                                    return;
                                }
                                s.checklist.selected.retain(|&v| v != i);
                                if *checked {
                                    s.checklist.selected.push(i);
                                    s.checklist.selected.sort_unstable();
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(div().font_weight(FontWeight::SEMIBOLD).child(format!(
                                "{} · {}점",
                                run.name(i),
                                item["score"]
                            )))
                            .child(div().mt_1().text_color(p.muted()).child(
                                item["description"].as_str().unwrap_or_default().to_owned(),
                            )),
                    )
                    .child(div().w(px(70.)).flex_none().flex().child(status_chip(
                        if position.is_none() {
                            "제외"
                        } else if position.is_some_and(|j| j < done) {
                            "완료"
                        } else if current {
                            "진행 중"
                        } else if run.failed {
                            "중단"
                        } else {
                            "대기"
                        },
                        p,
                    )))
                    .child(div().w(px(70.)).flex_none().flex().map(|d| {
                        match position.and_then(|j| run.results.get(j)) {
                            Some(result) => d.child(status_chip(result, p)),
                            None => d.text_color(p.muted()).child("—"),
                        }
                    })),
            );
        }
        let button = |label: &'static str| {
            div()
                .id(label)
                .rounded_md()
                .border_1()
                .border_color(border)
                .px_2()
                .py_1()
                .cursor_pointer()
                .child(label)
        };
        let mut actions = div()
            .p_3()
            .flex()
            .items_center()
            .justify_end()
            .gap_2()
            .child(run.error.clone());
        if active {
            actions = actions.child(
                run.current
                    .map(|i| format!("{} · 모의 분석 중", run.name(i)))
                    .unwrap_or_else(|| "모의 엔진 응답 대기".into()),
            );
        } else {
            actions=actions.child(button(if run.locked {"새 점검 준비"} else {"선택 항목 점검 시작"})
                .bg(rgb(0x4f46e5)).text_color(rgb(0xffffff))
                .when(run.pending||total==0,|d|d.opacity(0.5))
                .when(!run.pending&&total>0,|d|d.on_click(cx.listener(|s,_,_,cx|{
                    s.checklist.pending=true;s.checklist.error.clear();
                    s.conn.inspection_request(s.checklist.locked,serde_json::json!({"selected":s.checklist.selected,"files":s.inspection_files,"device":s.device["deviceId"]}));cx.notify();
                }))));
        }
        let progress = card()
            .flex_1()
            .min_h_0()
            .child(header("점검 진행", format!("{done} / {total} 완료")))
            .child(
                div().h(px(3.)).bg(border).child(
                    div()
                        .h_full()
                        .w(relative(done as f32 / total.max(1) as f32))
                        .bg(rgb(0x6366f1)),
                ),
            )
            .child(columns)
            .child(
                div()
                    .relative()
                    .min_h_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .child(table)
                    .vertical_scrollbar(&run.table_scroll),
            )
            .child(
                div()
                    .flex_none()
                    .border_t_1()
                    .border_color(border)
                    .child(actions),
            );
        let query = self
            .inspection_search
            .read(cx)
            .value()
            .trim()
            .to_lowercase();
        let matches: Vec<_> = self
            .library
            .iter()
            .filter(|n| n.to_lowercase().contains(&query))
            .collect();
        let files = card()
            .h(relative(0.28))
            .max_h(px(210.))
            .min_h(px(108.))
            .child(header(
                "동선 파일 선택",
                format!("{}개 선택", self.inspection_files.len()),
            ))
            .child(
                div()
                    .px_3()
                    .py_2()
                    .child(gpui_component::input::Input::new(&self.inspection_search).h(px(32.))),
            )
            .child(
                div()
                    .id("inspect-flow-files")
                    .overflow_y_scroll()
                    .px_3()
                    .pb_2()
                    .flex_1()
                    .min_h_0()
                    .when(matches.is_empty(), |d| {
                        d.child(if self.library.is_empty() {
                            "저장된 동선이 없습니다."
                        } else {
                            "검색 결과가 없습니다."
                        })
                    })
                    .children(matches.into_iter().enumerate().map(|(i, name)| {
                        let name = name.clone();
                        div().py_1().child(
                            Checkbox::new(("inspect-file", i))
                                .label(name.clone())
                                .checked(self.inspection_files.contains(&name))
                                .disabled(run.locked)
                                .on_click(cx.listener(move |s, checked: &bool, _, cx| {
                                    if *checked {
                                        s.inspection_files.insert(name.clone());
                                    } else {
                                        s.inspection_files.remove(&name);
                                    }
                                    cx.notify();
                                })),
                        )
                    })),
            );
        let center = div()
            .flex()
            .flex_col()
            .gap_3()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .child(files)
            .child(progress);
        div()
            .flex()
            .flex_1()
            .gap_3()
            .py_2()
            .pl_4()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .child(journal)
            .child(center)
    }
}
