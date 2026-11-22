import type { PromptEnhanceFramework, PromptEnhanceTarget } from "./contract.js";

/**
 * Deterministic prompt-shape classifier.
 *
 * The enhancer never asks the author what they meant. It derives a coarse domain,
 * task kind and the least-surprising framework from the draft, target and mode.
 * The model then fills the framework; it does not choose whether to interrogate.
 */
export interface PromptEnhanceClassification {
  domain: string;
  taskKind: string;
  framework: PromptEnhanceFramework;
  reasons: string[];
}

const DOMAIN_RULES: ReadonlyArray<{ domain: string; pattern: RegExp }> = [
  {
    domain: "coding",
    pattern:
      /(?:\bcode\b|\bbug\b|\bfix\b|\brefactor\b|\btest\b|\bapi\b|\btypescript\b|\breact\b|\bpython\b|\bsql\b|\brepo\b|\bfunction\b|\bstack\b|\bcompile\b|код|баг|тест|рефактор|ошибк|функци)/iu,
  },
  {
    domain: "design",
    pattern:
      /(?:\bdesign\b|\bui\b|\bux\b|\bfigma\b|\btypography\b|\bcolor\b|\blayout\b|\bmobile\b|дизайн|интерфейс|верстк|типографик)/iu,
  },
  {
    domain: "marketing",
    pattern:
      /(?:\bmarketing\b|\bcampaign\b|\bcopy\b|\bad\b|\blanding\b|\bseo\b|\baudience\b|\bbrand\b|маркетинг|реклам|копирайт|лендинг|аудитор|бренд)/iu,
  },
  {
    domain: "research",
    pattern:
      /(?:\bresearch\b|\banaly[sz]e\b|\bcompare\b|\bsources?\b|\bevidence\b|\bstudy\b|исслед|анализ|сравн|источник|доказательств)/iu,
  },
  {
    domain: "operations",
    pattern:
      /(?:\bdeploy\b|\brelease\b|\bci\b|\binfra\b|\bdocker\b|\bkubernetes\b|\bserver\b|деплой|релиз|инфраструктур|сервер)/iu,
  },
  {
    domain: "finance",
    pattern: /(?:\bfinance\b|\bbudget\b|\brevenue\b|\bforecast\b|финанс|бюджет|выручк|прогноз)/iu,
  },
  {
    domain: "legal",
    pattern:
      /(?:\blegal\b|\bcontract\b|\bcompliance\b|\bprivacy\b|юрид|договор|комплаенс|приватност)/iu,
  },
  {
    domain: "education",
    pattern: /(?:\blesson\b|\bquiz\b|\bcurriculum\b|\bstudent\b|урок|тест|студент|обучен)/iu,
  },
];

const TASK_RULES: ReadonlyArray<{ taskKind: string; pattern: RegExp }> = [
  {
    taskKind: "bugfix",
    pattern: /(?:\bbug\b|\bfix\b|\bcrash\b|\bbroken\b|\berror\b|баг|исправ|ошибк|падает)/iu,
  },
  {
    taskKind: "review",
    pattern: /(?:\breview\b|\baudit\b|\bcheck\b|\bdiff\b|ревью|аудит|проверь|дифф)/iu,
  },
  {
    taskKind: "research",
    pattern: /(?:\bresearch\b|\bcompare\b|\bfind\b|\bsources?\b|исслед|сравн|найди|источник)/iu,
  },
  {
    taskKind: "writing",
    pattern: /(?:\bwrite\b|\bcopy\b|\barticle\b|\bpost\b|\bemail\b|напиши|текст|стать|письм)/iu,
  },
  {
    taskKind: "planning",
    pattern: /(?:\bplan\b|\broadmap\b|\bstrategy\b|\bsteps?\b|план|стратег|шаг)/iu,
  },
  {
    taskKind: "design",
    pattern: /(?:\bdesign\b|\bui\b|\bux\b|\bfigma\b|дизайн|интерфейс|верстк)/iu,
  },
  {
    taskKind: "feature",
    pattern: /(?:\badd\b|\bimplement\b|\bbuild\b|\bcreate\b|добав|реализ|созда|внедр)/iu,
  },
  {
    taskKind: "refactor",
    pattern: /(?:\brefactor\b|\bcleanup\b|\bmigrate\b|рефактор|миграц|переписа)/iu,
  },
  {
    taskKind: "operations",
    pattern: /(?:\bdeploy\b|\brelease\b|\bci\b|деплой|релиз)/iu,
  },
];

const EXAMPLE_PATTERN =
  /(?:\bexample\b|\blike this\b|\bsample\b|например|образец|пример|示例|样例)/iu;
const MULTI_STEP_PATTERN =
  /(?:\bstep\b|\bplan\b|\bimplement\b|\bmigrate\b|\brefactor\b|\bfeature\b|\bthen\b|шаг|план|реализ|миграц|рефактор|затем)/iu;

export function classifyPromptEnhanceTask(input: {
  draftText: string;
  target: PromptEnhanceTarget;
  collaborationMode?: string;
}): PromptEnhanceClassification {
  const text = input.draftText.trim();
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  const domain = DOMAIN_RULES.find((rule) => rule.pattern.test(lower))?.domain ?? "general";
  if (domain !== "general") reasons.push(`domain:${domain}`);
  const taskKind =
    TASK_RULES.find((rule) => rule.pattern.test(lower))?.taskKind ??
    (input.target === "custom_system_prompt" ? "system_prompt" : "general");
  if (taskKind !== "general") reasons.push(`task:${taskKind}`);

  let framework: PromptEnhanceFramework;
  if (EXAMPLE_PATTERN.test(lower)) {
    framework = "care";
    reasons.push("framework:care-example");
  } else if (
    text.length < 90 &&
    !MULTI_STEP_PATTERN.test(lower) &&
    input.collaborationMode !== "plan"
  ) {
    framework = "tag";
    reasons.push("framework:tag-short");
  } else if (
    MULTI_STEP_PATTERN.test(lower) ||
    input.collaborationMode === "plan" ||
    taskKind === "feature" ||
    taskKind === "bugfix" ||
    taskKind === "refactor" ||
    taskKind === "planning"
  ) {
    framework = "rise";
    reasons.push("framework:rise-multistep");
  } else if (text.length > 600 || domain === "general") {
    framework = "oracle";
    reasons.push("framework:oracle-open-ended");
  } else {
    framework = "oracle";
    reasons.push("framework:oracle-default");
  }

  return { domain, taskKind, framework, reasons };
}
