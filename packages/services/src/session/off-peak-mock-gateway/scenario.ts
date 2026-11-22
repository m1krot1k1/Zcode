/* 确定性 E2E 脚本：识别 foreground-subagents / capture 场景的请求阶段并给出固定应答。
   仅当 config.scenario 命中时才被网关调用，生产与普通 mock 演示不会走到这里。 */
import { anthropicMockResponse, type AnthropicMockResponse } from "./anthropic-mock.js";

const FOREGROUND_SUBAGENT_SCENARIO = {
  parentMarker: "E2E_OFFPEAK_SUBAGENTS_PARENT",
  parentFinal: "E2E_OFFPEAK_SUBAGENTS_PARENT_OK",
  children: [
    {
      stage: "child-explore",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK",
      toolId: "toolu_e2e_offpeak_explore",
      input: {
        description: "Verify Explore foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_EXPLORE_OK.",
        subagent_type: "Explore",
      },
    },
    {
      stage: "child-general-purpose",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK",
      toolId: "toolu_e2e_offpeak_general",
      input: {
        description: "Verify general-purpose foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_GENERAL_OK.",
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "child-code-search",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK",
      toolId: "toolu_e2e_offpeak_code_search",
      input: {
        description: "Verify custom Code Search foreground inheritance",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_CODE_SEARCH_OK.",
        subagent_type: "Code Search",
      },
    },
    {
      stage: "child-custom-inherit",
      marker: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT",
      reply: "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK",
      toolId: "toolu_e2e_offpeak_inherit",
      input: {
        description: "Verify custom inherited-model foreground agent",
        prompt:
          "E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT: reply exactly E2E_OFFPEAK_SUBAGENT_CHILD_INHERIT_OK.",
        subagent_type: "E2E OffPeak Inherit Reviewer",
      },
    },
  ],
  backgrounds: [
    {
      stage: "background-explicit",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT",
      toolId: "toolu_e2e_offpeak_background_explicit",
      input: {
        description: "Verify explicit background inheritance",
        prompt: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_EXPLICIT: reply when released.",
        run_in_background: true,
        subagent_type: "general-purpose",
      },
    },
    {
      stage: "background-profile",
      marker: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE",
      toolId: "toolu_e2e_offpeak_background_profile",
      input: {
        description: "Verify profile background inheritance",
        prompt: "E2E_OFFPEAK_SUBAGENT_BACKGROUND_PROFILE: reply when released.",
        subagent_type: "E2E OffPeak Background Reviewer",
      },
    },
  ],
} as const;

export function classifyForegroundSubagentScenarioRequest(requestJson: unknown): string {
  const serialized = JSON.stringify(requestJson);
  // 标题包含相同用户素材，必须先按 system 任务区分，否则会误触发整套 Agent 脚本。
  if (serialized.includes("Generate a concise title for this coding session."))
    return "session-title";
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
    if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentFinal)) return "parent-wakeup";
    if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.children[0].toolId))
      return "parent-continuation";
    return "parent-initial";
  }
  for (const child of FOREGROUND_SUBAGENT_SCENARIO.children) {
    if (serialized.includes(child.marker)) return child.stage;
  }
  for (const background of FOREGROUND_SUBAGENT_SCENARIO.backgrounds) {
    if (serialized.includes(background.marker)) return background.stage;
  }
  if (serialized.includes(FOREGROUND_SUBAGENT_SCENARIO.parentMarker)) {
    return "parent-initial";
  }
  return "unknown";
}

export function buildForegroundSubagentScenarioResponse(
  stage: string,
  port: number,
): AnthropicMockResponse | undefined {
  if (stage === "session-title") {
    return anthropicMockResponse({
      content: [{ type: "text", text: '{"title":"E2E 闲时后台验证"}' }],
      stopReason: "end_turn",
    });
  }
  if (stage === "parent-initial") {
    return anthropicMockResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_e2e_offpeak_bash",
          name: "Bash",
          input: {
            run_in_background: true,
            command: `node -e 'fetch("http://127.0.0.1:${port}/__e2e/off-peak/background-bash").then(r=>r.text()).then(console.log)'`,
          },
        },
        ...FOREGROUND_SUBAGENT_SCENARIO.children.map((child) => ({
          type: "tool_use" as const,
          id: child.toolId,
          name: "Agent",
          input: child.input,
        })),
        ...FOREGROUND_SUBAGENT_SCENARIO.backgrounds.map((background) => ({
          type: "tool_use" as const,
          id: background.toolId,
          name: "Agent",
          input: background.input,
        })),
      ],
      stopReason: "tool_use",
    });
  }
  const child = FOREGROUND_SUBAGENT_SCENARIO.children.find(
    (candidate) => candidate.stage === stage,
  );
  if (child) {
    return anthropicMockResponse({
      content: [{ type: "text", text: child.reply }],
      stopReason: "end_turn",
    });
  }
  const background = FOREGROUND_SUBAGENT_SCENARIO.backgrounds.find(
    (candidate) => candidate.stage === stage,
  );
  if (background) {
    return anthropicMockResponse({
      content: [{ type: "text", text: `${background.marker}_OK` }],
      stopReason: "end_turn",
    });
  }
  if (stage === "parent-continuation" || stage === "parent-wakeup") {
    return anthropicMockResponse({
      content: [{ type: "text", text: FOREGROUND_SUBAGENT_SCENARIO.parentFinal }],
      stopReason: "end_turn",
    });
  }
  return undefined;
}
