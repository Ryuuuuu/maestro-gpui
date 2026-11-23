use super::{Palette, Viewer};
use gpui::{prelude::*, *};
use gpui_component::{Disableable, checkbox::Checkbox};
use serde_json::Value;
use std::time::Instant;

pub(super) struct Checklist {
    items: Vec<Value>,
    selected: Vec<usize>,
    started: Option<Instant>,
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
            started: None,
            results: vec![],
            log: vec![],
        }
    }

    fn name(&self, index: usize) -> &str {
        self.items[index]["name"].as_str().unwrap_or_default()
    }

    fn start(&mut self) {
        let Some(&first) = self.selected.first() else {
            return;
        };
        self.started = Some(Instant::now());
        self.results.clear();
        self.log = vec![("+00:00".into(), format!("{} 점검 시작", self.name(first)))];
    }

    fn record(&mut self, result: &str) {
        let Some(started) = self.started else { return };
        let index = self.results.len();
        let Some(&item) = self.selected.get(index) else {
            return;
        };
        let seconds = started.elapsed().as_secs();
        let time = format!("+{:02}:{:02}", seconds / 60, seconds % 60);
        self.log
            .push((time.clone(), format!("{} · {result}", self.name(item))));
        self.results.push(result.into());
        let next = if let Some(&next_item) = self.selected.get(index + 1) {
            format!("{} 점검 시작", self.name(next_item))
        } else {
            "선택 항목 점검 완료".into()
        };
        self.log.push((time, next));
    }
}

impl Viewer {
    pub(super) fn inspection_panels(&self, p: Palette, cx: &Context<Self>) -> Div {
        let run = &self.checklist;
        let done = run.results.len();
        let total = run.selected.len();
        let active = run.started.is_some() && done < total;
        let border = p.border();
        let card = || {
            div()
                .flex()
                .flex_col()
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
            .flex_1()
            .min_w(px(150.))
            .child(header("점검 실행 로그", format!("{}건", run.log.len())))
            .child(
                div()
                    .id("inspection-journal")
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
        let cell = |text: String| div().w(px(52.)).child(text);
        let mut table = div().id("inspection-table").overflow_y_scroll().child(
            row()
                .bg(p.panel())
                .child(div().flex_1().child("점검 항목"))
                .child(cell("상태".into()))
                .child(cell("결과".into())),
        );
        for (i, item) in run.items.iter().enumerate() {
            let position = run.selected.iter().position(|&item| item == i);
            let current = active && position == Some(done);
            table = table.child(
                row()
                    .when(current, |d| d.bg(p.color(0xeef2ff, 0x292842)))
                    .child(
                        Checkbox::new(("inspection-choice", i))
                            .checked(position.is_some())
                            .disabled(run.started.is_some())
                            .on_click(cx.listener(move |s, checked: &bool, _, cx| {
                                if s.checklist.started.is_some() {
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
                            .child(
                                div()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(run.name(i).to_owned()),
                            )
                            .child(div().mt_1().text_color(p.muted()).child(
                                item["description"].as_str().unwrap_or_default().to_owned(),
                            )),
                    )
                    .child(cell(
                        if position.is_none() {
                            "제외"
                        } else if position.is_some_and(|j| j < done) {
                            "완료"
                        } else if current {
                            "진행 중"
                        } else {
                            "대기"
                        }
                        .into(),
                    ))
                    .child(cell(
                        position
                            .and_then(|j| run.results.get(j))
                            .cloned()
                            .unwrap_or_else(|| "—".into()),
                    )),
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
        let actions = if active {
            div()
                .p_3()
                .child(format!("{} 결과 기록", run.name(run.selected[done])))
                .child(div().flex().mt_2().gap_1().children(
                    ["양호", "취약", "판단 보류"].into_iter().map(|label| {
                        button(label).on_click(cx.listener(move |s, _, _, cx| {
                            s.checklist.record(label);
                            cx.notify();
                        }))
                    }),
                ))
        } else {
            div()
                .p_3()
                .flex()
                .when(run.started.is_none(), |d| d.justify_end())
                .child(
                    button(if run.started.is_some() {
                        "새 점검 준비"
                    } else {
                        "선택 항목 점검 시작"
                    })
                    .bg(rgb(0x4f46e5))
                    .text_color(rgb(0xffffff))
                    .when(total == 0, |d| d.opacity(0.5))
                    .when(total > 0, |d| {
                        d.on_click(cx.listener(|s, _, _, cx| {
                            if s.checklist.started.is_some() {
                                s.checklist.started = None;
                                s.checklist.results.clear();
                                s.checklist.log.clear();
                            } else {
                                s.checklist.start();
                            }
                            cx.notify();
                        }))
                    }),
                )
        };
        let progress = card()
            .flex_grow()
            .flex_basis(px(180.))
            .min_w(px(260.))
            .child(header("점검 진행", format!("{done} / {total} 완료")))
            .child(
                div().h(px(3.)).bg(border).child(
                    div()
                        .h_full()
                        .w(relative(done as f32 / total.max(1) as f32))
                        .bg(rgb(0x6366f1)),
                ),
            )
            .child(table.child(actions));
        div()
            .flex()
            .flex_1()
            .gap_3()
            .py_2()
            .pl_4()
            .child(journal)
            .child(progress)
    }
}
