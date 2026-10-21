import { invoke } from "@tauri-apps/api/core";

/** Record only timing milestones, never answer or transcript contents. */
export function recordAnswerRender(milestone: "first_text" | "first_sentence") {
  void invoke("record_answer_render", { milestone }).catch(() => {});
}
