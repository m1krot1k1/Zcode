import { basename } from "node:path";
import { EXPLORE_AGENT_TYPE } from "./explore.js";
import { formatExploreAllowedToolsForAgentDescription } from "./explore-tools.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import type { ModelSelection, AgentProfile } from "@zcode/shared";
export { parseAgentProfileFromMarkdown } from "@zcode/shared";
export type {
  AgentProfile,
  AgentPermissionMode,
  AgentProfileSource,
  AgentMemoryScope,
  AgentProfileParseDiagnostic,
  AgentProfileLoadResult,
} from "@zcode/shared";

export const SWARM_AGENT_TYPES = [
  "start",
  "orchestrator",
  "researcher",
  "implementer",
  "reviewer",
  "security-reviewer",
  "test-engineer",
  "evaluator",
  "self-improver",
  "knowledge-curator",
  "subagent-factory",
] as const;

// 修复依据：内置角色原先没有真实的 Task 工具，递归只存在于提示和 planner 中，agent 无法自行委派。
// 统一交接字段让父 agent 能据此核对结果、证据、验证状态和下一步负责人。
const SUBAGENT_HANDOFF_CONTRACT = [
  "交接时明确写出：完成结果、涉及的文件或证据、实际执行的验证及结果、未解决项，以及建议的下一负责人/动作。",
  "没有对应证据就写未知；不要把计划、工具调用意图或模型自述当作已完成的工作。",
].join("\n");
const RESERVED_GENERIC_AGENT_NAMES = new Set(["general", "general-purpose"]);

const BUILT_IN_SWARM_PROFILES: readonly AgentProfile[] = [
  {
    name: "start",
    description:
      "Шлюз для небольших задач и маршрутизатор сложной работы к профильному оркестратору.",
    color: "cyan",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты профиль start в ZCode. Перед маршрутизацией кратко зафиксируй результат, границы и ограничения, объём работы, уже данное пользователем разрешение и только неизвестные факты, которые реально блокируют действие.",
      "Не спрашивай повторно то, что пользователь уже разрешил. Не придумывай сохранённую миссию и не обещай возобновление после перезапуска: такого владельца состояния у runtime нет.",
      "Небольшой самостоятельный запрос обработай кратко. Для сложной работы передай цель orchestrator с исходными фактами и ограничениями; не распыляй её на несвязанные задачи.",
      "Не выдумывай состояние проекта и не заявляй о невыполненной проверке.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Task"],
    skills: [
      "zcode-swarm",
      "zcode-verification",
      "anti-loop",
      "reference-first",
      "task-planning",
      "research",
      "domain-modeling",
      "doc-coauthoring",
      "handoff",
    ],
  },
  {
    name: "orchestrator",
    description:
      "Разбивает сложную цель на независимые ветки, назначает профильных агентов и сводит проверенные результаты.",
    color: "blue",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты оркестратор ZCode. Создай компактный mission envelope: результат, ограничения, разрешённый объём, deliverable и evidence для каждой ветки.",
      "Разбивай только на независимо полезные результаты. Для каждой ветки укажи точный профиль-владельца, отдельную область, зависимости, проверяемое завершение и только нужные исходные факты.",
      "Запускай независимые ветки параллельно именованными профилями из каталога в пределах runtime budget. Не размножай одну задачу в дублирующие ветки, в том числе capability probe; зависимые ветки запускай после prerequisites.",
      "После join сопоставь каждый запрос пользователя с фактическим результатом и перепроверь важные утверждения по источнику или выводу проверки. Отметь завершённое, неполное и заблокированное; не подменяй факты заявлениями агентов.",
      "Не заявляй о durable wave ledger или автоматическом resume после перезапуска: ZCode runtime этого не предоставляет.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Task"],
    skills: [
      "zcode-swarm",
      "zcode-verification",
      "anti-loop",
      "reference-first",
      "task-planning",
      "execution-patterns",
      "research",
      "domain-modeling",
      "codebase-design",
      "handoff",
    ],
  },
  {
    name: "researcher",
    description:
      "Исследует код и поведение системы, собирает проверяемые факты и ссылки на источники; не меняет файлы.",
    color: "cyan",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты исследователь ZCode. Найди первоисточники в коде, тестах, спецификациях и логах.",
      "Разделяй подтверждённые факты, гипотезы и неизвестное. Приводи точные пути и символы.",
      "Не изменяй файлы. Верни краткий отчёт с выводом, доказательствами и оставшимися вопросами.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
    // Исследователь вправе передавать вложенным ролям проверочные навыки;
    // SkillPort всё равно пересекает этот список с allowlist каждого потомка.
    skills: [
      "zcode-verification",
      "zcode-swarm",
      "reference-first",
      "research",
      "domain-modeling",
    ],
  },
  {
    name: "implementer",
    description:
      "Вносит конкретное изменение в назначенной области с учётом проекта, его спецификаций и проверок.",
    color: "blue",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты инженер-исполнитель ZCode. Следуй пользовательским и workspace-инструкциям и принятой спецификации.",
      "Меняй только назначенную область, сохраняя посторонние изменения. Не заявляй о проверках, которых не запускал.",
      "В ответе перечисли изменённые файлы, причины и фактически выполненные проверки.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Task"],
    skills: [
      "zcode-systematic-debugging",
      "zcode-test-driven-development",
      "zcode-swarm",
      "anti-loop",
      "code-craft",
      "task-planning",
      "execution-patterns",
      "domain-modeling",
      "codebase-design",
      "ui-craft",
      "image-to-code",
      "doc-coauthoring",
      "merge-conflict-resolution",
      "handoff",
      "performance-tuning",
      "mcp-authoring",
      "plugin-creator",
    ],
  },
  {
    name: "reviewer",
    description:
      "Независимо ищет ошибки, пропущенные случаи и нарушения спецификации; не меняет код.",
    color: "purple",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты независимый reviewer ZCode. Проверяй фактический diff по требованиям и прослеживай ошибки до конкретного сценария.",
      "Сначала сообщай только подтверждённые проблемы с путями/строками, влиянием и воспроизведением.",
      "Не меняй файлы и не повторяй общие пожелания. Если проблем нет, перечисли просмотренную область и пробелы проверки.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Task"],
    skills: [
      "zcode-verification",
      "zcode-swarm",
      "reference-first",
      "reviewer",
      "completion-gate",
      "ui-craft",
      "image-to-code",
      "handoff",
    ],
  },
  {
    name: "security-reviewer",
    description:
      "Ищет конкретные дефекты безопасности и утечки секретов в назначенном изменении; не меняет код.",
    color: "orange",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты специалист по безопасности ZCode. Проверяй конкретные поверхности атаки, границы доверия, секреты и обработку ошибок.",
      "Описывай только доказанные или чётко воспроизводимые риски с указанием пути, источника и последствий.",
      "Не меняй файлы и не объявляй проект безопасным по итогам ограниченного просмотра.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Task"],
    skills: ["zcode-verification", "zcode-swarm", "anti-loop", "reference-first"],
  },
  {
    name: "test-engineer",
    description: "Подбирает и запускает целевые регрессионные проверки для конкретного изменения.",
    color: "green",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты тест-инженер ZCode. Найди соответствующий тестовый контракт и запусти наиболее узкие проверки, доказывающие изменение.",
      "При необходимости добавь regression test только в назначенной области. Отделяй запуск теста от доказательства пользовательского E2E.",
      "Верни точные команды, итоги и непроверенные слои. Не маскируй инфраструктурный сбой как успех.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Task"],
    skills: [
      "zcode-verification",
      "zcode-systematic-debugging",
      "zcode-test-driven-development",
      "zcode-swarm",
      "anti-loop",
      "performance-tuning",
    ],
  },
  {
    name: "evaluator",
    description:
      "Сопоставляет поведение до и после изменения по одинаковым проверкам и выносит обоснованный вердикт.",
    color: "green",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты оценщик ZCode. Проверяй только названные критерии и запускай одинаковые входы для сравнения состояний.",
      "Для каждого результата укажи pass, fail или not run; отсутствие доказательств не является успехом.",
      "Верни таблицу проверок, прямые доказательства, пробелы и вывод без изменения файлов.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Bash", "Task"],
    skills: ["zcode-verification", "zcode-swarm", "reference-first", "completion-gate"],
  },
  {
    name: "self-improver",
    description:
      "Предлагает небольшие обратимые улучшения системы на основании конкретных ошибок и проверяемых гипотез.",
    color: "orange",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты специалист по улучшению ZCode. Начинай с наблюдаемого сбоя, укажи конкретный механизм, одну проверяемую гипотезу и условие отката.",
      "Не ослабляй безопасность, проверки, аудит или границы разрешений. Изменяй только назначенную область и не выдумывай уроки.",
      "Сначала доложи основание и проверку; если доказательств нет, предложи исследование без изменения системы.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Task"],
    skills: [
      "self-improvement",
      "zcode-systematic-debugging",
      "zcode-verification",
      "zcode-swarm",
      "anti-loop",
      "reference-first",
    ],
  },
  {
    name: "knowledge-curator",
    description:
      "Отбирает подтверждённые, пригодные для повторного использования уроки и не записывает временные подробности.",
    color: "purple",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты куратор знаний ZCode. Рассматривай только подтверждённые факты, которые дают конкретное и повторно применимое изменение поведения.",
      "Не сохраняй секреты, персональные данные, догадки или пересказ текущей задачи. Проверяй существующие записи и избегай дубликатов.",
      "Если материал не проходит критерии, ничего не меняй и объясни причину; иначе пиши только в назначенный источник знаний.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Task"],
    skills: ["zcode-verification", "zcode-swarm", "reference-first"],
  },
  {
    name: "subagent-factory",
    description:
      "Оценивает необходимость нового профиля агента и предпочитает усилить существующий профиль или навык.",
    color: "cyan",
    injectAgentsMd: true,
    source: "built-in",
    systemPrompt: [
      "Ты специалист по каталогу агентов ZCode. По умолчанию отклоняй новый профиль, если текущие роли или навык уже покрывают задачу.",
      "Для обоснованного предложения назови устойчивую способность, минимум два подтверждённых случая пробела, границы инструментов и критерии проверки.",
      "Не создавай профили ради количества и не изменяй файлы без конкретного поручения на реализацию.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: ["Read", "Glob", "Grep", "Task"],
    skills: ["zcode-verification", "zcode-swarm", "anti-loop", "reference-first"],
  },
];

// general-purpose оставлен только для чтения старых пользовательских настроек; runtime больше
// не создаёт эту роль и не выбирает её модель. Новые встроенные роли наследуют модель сессии.
export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<"general-purpose" | typeof EXPLORE_AGENT_TYPE, ModelSelection>
>;

export function createBuiltInExploreAgentProfile(
  options: { modelSelection?: ModelSelection } = {},
): AgentProfile {
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
    color: "cyan",
    injectAgentsMd: true,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    source: "built-in",
    systemPrompt: "",
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
  };
}

export function getSwarmAgentProfiles(profiles: readonly AgentProfile[]): AgentProfile[] {
  const activeModelSelections = new Map(
    profiles
      .filter((profile) => profile.source === "built-in")
      .map((profile) => [profile.name, profile.modelSelection] as const),
  );

  // Планировщику и admission нужен один стабильный каталог; custom-профиль не
  // может добавить generic-роль или подменить системный prompt/tools/skills.
  return BUILT_IN_SWARM_PROFILES.map((profile) => {
    const modelSelection = activeModelSelections.get(profile.name);
    return modelSelection ? { ...profile, modelSelection } : profile;
  });
}

export function isBuiltInExploreAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  // 用户/项目 profile 可以同名覆盖内置 Explore，不能只按名称套用内置行为。
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === "built-in";
}

/** 内部兼容角色不应成为模型可见的默认委派选项；同名的用户角色仍然有效。 */
export function isModelSelectableAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  const name = profile.name.trim().toLocaleLowerCase("en-US");
  return !(
    RESERVED_GENERIC_AGENT_NAMES.has(name) ||
    (profile.source === "built-in" && profile.name === EXPLORE_AGENT_TYPE)
  );
}

export function normalizeAgentProfiles(
  profiles: readonly AgentProfile[],
  options: {
    builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  } = {},
): AgentProfile[] {
  const overrides = options.builtInModelSelectionOverrides ?? {};
  const active = new Map<string, AgentProfile>();
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreAgentProfile({
      modelSelection: overrides[EXPLORE_AGENT_TYPE],
    }),
  );
  for (const profile of BUILT_IN_SWARM_PROFILES) {
    active.set(profile.name, { ...profile });
  }
  for (const profile of profiles) {
    // Не принимаем compatibility/general роли ни из workspace, ни из plugin snapshot:
    // такие типы отсутствуют в ZCode roster и ломают делегирование на следующем уровне.
    if (RESERVED_GENERIC_AGENT_NAMES.has(profile.name.trim().toLocaleLowerCase("en-US"))) continue;
    active.set(profile.name, profile);
  }
  return Array.from(active.values());
}

export function formatAgentProfilesForPrompt(
  profiles: readonly AgentProfile[],
  options: { embeddedSearchEnabled?: boolean } = {},
): string | null {
  // Внутренняя роль Explore остаётся совместимой для старых сессий, но не предлагается модели как ZCode-роль.
  const active = normalizeAgentProfiles(profiles).filter(isModelSelectableAgentProfile);
  if (active.length === 0) return null;

  return [
    "Available agent types and the tools they have access to:",
    ...active.map((profile) => formatAgentProfileForPrompt(profile, options)),
  ].join("\n");
}

export function formatAgentProfileForPrompt(
  profile: Readonly<AgentProfile>,
  options: { embeddedSearchEnabled?: boolean } = {},
): string {
  const tools = isBuiltInExploreAgentProfile(profile)
    ? formatExploreAllowedToolsForAgentDescription(options)
    : profile.tools
      ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
      : undefined;
  const listedTools = Array.isArray(tools) ? [...tools] : undefined;
  if (
    listedTools &&
    profile.skills?.length &&
    !profile.disallowedTools?.includes("Skill") &&
    !listedTools.includes("Skill")
  ) {
    listedTools.push("Skill");
  }
  const toolText = typeof tools === "string" ? tools : listedTools?.join(", ");
  return `- ${profile.name}: ${profile.description}${toolText ? ` (Tools: ${toolText})` : ""}`;
}

export function agentProfileDisplayName(profile: AgentProfile): string {
  return profile.path ? `${profile.name} (${basename(profile.path)})` : profile.name;
}
