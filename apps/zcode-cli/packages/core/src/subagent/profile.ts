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
// 修复依据：start 曾以「Grep/Glob/Bash 不在我的工具集里」为由拒绝执行 L1–L4 自检，
// 而 runtime 元数据是 profileSnapshot.tools=[Read,Glob,Grep,Task]、toolCallCount=0、finishReason=stop：
// 提示里既没有工具清单，也没有层级语义和「必须真实调用」的要求，模型零调用就结束了。
// 现在所有内置角色拿到同一套能力面；角色差异只保留在系统提示的行为约束里。
const START_TOOLING_AND_NESTING_CONTRACT = [
  "Твои инструменты: child-safe набор, включая Read, Glob, Grep, Write, Edit, Bash, WebFetch, Task и Skill. WebSearch доступен только если модель поддерживает native search; иначе используй WebFetch или Bash. Root-only инструменты (Cron*, Workflow, EnterWorktree/ExitWorktree, ScheduleWakeup, TaskCreate/Get/List/Update) субагентам не выдаются. Не заявляй об инструменте, которого нет в текущем ответе хоста; если хост отклонил вызов, зафиксируй это и продолжи доступным способом.",
  "Вложенность измеряется глубиной цепочки Task: L1 — Task вызвал ты, L2 — Task вызвал твой ребёнок, L3 — его ребёнок, L4 — четвёртый уровень. L4 — достаточная глубина для проверки вложенности; глубже без прямой просьбы пользователя не ныряй.",
  "Глубина сама по себе не ограничивает работу: ограничивают бюджет спавнов (remaining_spawns) и параллелизм (max_parallel). Номер уровня — только запись, а не стоп-условие.",
  "Каждый уровень подтверждается только собственным вызовом Task в его транскрипте; скопированная строка из ответа ребёнка доказательством не является, и мелкий PASS не доказывает глубокий.",
  "Перед делегированием кратко зафиксируй: результат, ограничения, объём, уже данное разрешение и только те неизвестные, что блокируют действие.",
  "Каждому ребёнку выдай конверт: Branch ID, Parent ID, Level+1, remaining_spawns строго меньше твоего, max_parallel, непересекающиеся файлы, out-of-scope, критерий проверки и контракт завершения.",
  "Независимые ветки запускай одним сообщением; если их больше max_parallel — партиями с join между партиями.",
  "Никогда не вызывай Task(start) и не Task(orchestrator) без нового, более узкого конверта.",
  "Если Task недоступен или хост отказал — зафиксируй факт, один раз повтори при реально существующем инструменте, иначе выполни оставшийся объём сам.",
  "Не изобретай гейты, approval-шаги и выбор тира; не заявляй о работе и проверке, которых не было.",
].join("\n");

// Routing gate: start/orchestrator маршрутизируют, root интегрирует. Правило должно быть
// одинаковым в промпте и в тестируемой функции, иначе модель и код разойдутся.
const DELEGATION_ROUTING_CONTRACT = [
  "Перед действием классифицируй задачу: social-only → answer_directly; одна ограниченная задача → delegate_single; ≥2 независимых workstreams → orchestrate; последовательная интеграция, принадлежащая вызывающему → integrate_inline.",
  "start и orchestrator никогда не выбирают integrate_inline для реализации: они делегируют. integrate_inline доступен только root-сессии для последовательной сборки и финальной проверки.",
  "Зафиксируй решение одной строкой: route, reason, owner, max_parallel. Если route = orchestrate, перечисли ветки и их файловые области.",
].join("\n");
const RESERVED_GENERIC_AGENT_NAMES = new Set(["general", "general-purpose"]);

// 所有内置角色共享同一套工具能力；角色语义只由 systemPrompt 约束，不能再出现
// 「某个 profile 没有 Bash/Write」导致子 agent 无法完成本职责的情况。
// EnterPlanMode/ExitPlanMode 仍由 SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS 统一剔除。
const FULL_SUBAGENT_TOOL_NAMES = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
  "Skill",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "TaskOutput",
  "TaskStop",
] as const;

// Root-only / host-gated tools. subagent_child runtime does not register them
// (Cron/automation are disabled for subagent_child; Workflow/Worktree and task
// board tools belong to the root orchestration surface). Keeping them out of
// the profile list prevents the prompt from promising unavailable tools.
export const ROOT_ONLY_TOOL_NAMES = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "ScheduleWakeup",
  "Workflow",
  "EnterWorktree",
  "ExitWorktree",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
] as const;

export type DelegationRoute =
  | "answer_directly"
  | "delegate_single"
  | "orchestrate"
  | "integrate_inline";

export interface DelegationEnvelope {
  role: "start" | "orchestrator" | "root";
  socialOnly?: boolean;
  independentWorkstreams?: number;
  serialDependencies?: boolean;
  integrationOwnedByCaller?: boolean;
  /** Remaining spawn budget for this turn; 0 means the caller must not spawn. */
  spawnBudget?: number;
  /** User-provided parallelism cap; defaults to 4. */
  userMaxParallel?: number;
  /** Read-only triage may stay with the caller; implementation still delegates. */
  readOnly?: boolean;
}

export interface DelegationDecision {
  route: DelegationRoute;
  reason: string;
  maxParallel: number;
}

/** Pure routing gate used by prompts and tests; it never performs work itself. */
export function decideDelegationRoute(envelope: DelegationEnvelope): DelegationDecision {
  if (envelope.socialOnly === true) {
    return { route: "answer_directly", reason: "social-only request", maxParallel: 0 };
  }

  if (envelope.readOnly === true) {
    return {
      route: "integrate_inline",
      reason: "read-only triage stays with the caller",
      maxParallel: 0,
    };
  }

  const workstreams = Math.max(1, envelope.independentWorkstreams ?? 1);
  const spawnBudget = envelope.spawnBudget ?? Number.POSITIVE_INFINITY;
  const userMaxParallel = Math.max(1, envelope.userMaxParallel ?? 4);
  if (spawnBudget <= 0) {
    return { route: "integrate_inline", reason: "no spawn budget", maxParallel: 0 };
  }
  const maxParallel = Math.max(1, Math.min(workstreams, userMaxParallel, spawnBudget));
  if (workstreams >= 2 && maxParallel >= 2) {
    return {
      route: "orchestrate",
      reason: "multiple independent workstreams",
      maxParallel,
    };
  }

  if (envelope.role === "start" || envelope.role === "orchestrator") {
    return {
      route: "delegate_single",
      reason: `${envelope.role} never implements directly`,
      maxParallel: 1,
    };
  }

  if (envelope.serialDependencies === true || envelope.integrationOwnedByCaller === true) {
    return {
      route: "integrate_inline",
      reason: "serial or caller-owned integration",
      maxParallel: 0,
    };
  }

  return { route: "delegate_single", reason: "single bounded task", maxParallel: 1 };
}

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
      "Тривиальна только светская реплика без задачи: приветствие, благодарность, подтверждение — ответь сам. Любая задача, требующая изменения файлов, запуска команд, тестов или сбора доказательств, не тривиальна: ты не исполняешь её сам. Небольшой ограниченный объём делегируй профильному исполнителю (implementer/test-engineer/evaluator/researcher), сложную или многоветочную работу — orchestrator. Read-only триаж (Read/Glob/Grep/Bash без записи) разрешён; изменяющие команды, тесты и правки — только делегат. Write/Edit не применяй для реализации, пока Task доступен. Если Task недоступен, зафиксируй это и выполни минимальный объём сам.",
      "Не выдумывай состояние проекта и не заявляй о невыполненной проверке.",
      SUBAGENT_HANDOFF_CONTRACT,
      DELEGATION_ROUTING_CONTRACT,
      "",
      START_TOOLING_AND_NESTING_CONTRACT,
    ].join("\n"),
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
      "Ты не исполнитель: не реализуй ветки сам. Делегируй каждую независимую ветку профильному агенту; сам только собирай конверты, проверяй результаты и своди. Если ветка не делегируется, зафиксируй причину и не подменяй её своей реализацией.",
      "Разбивай только на независимо полезные результаты. Для каждой ветки укажи точный профиль-владельца, отдельную область, зависимости, проверяемое завершение и только нужные исходные факты.",
      "Запускай независимые ветки параллельно именованными профилями из каталога в пределах runtime budget. Не размножай одну задачу в дублирующие ветки, в том числе capability probe; зависимые ветки запускай после prerequisites.",
      "После join сопоставь каждый запрос пользователя с фактическим результатом и перепроверь важные утверждения по источнику или выводу проверки. Отметь завершённое, неполное и заблокированное; не подменяй факты заявлениями агентов.",
      "Не заявляй о durable wave ledger или автоматическом resume после перезапуска: ZCode runtime этого не предоставляет.",
      SUBAGENT_HANDOFF_CONTRACT,
      DELEGATION_ROUTING_CONTRACT,
    ].join("\n"),
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
      "По умолчанию не изменяй файлы; Write/Edit/Bash доступны, если без воспроизведения или минимальной правки проверка невозможна. Верни краткий отчёт с выводом, доказательствами и оставшимися вопросами.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
      "По умолчанию не меняй файлы; Write/Edit/Bash доступны для воспроизведения, но не для переписывания проверяемого кода. Не повторяй общие пожелания. Если проблем нет, перечисли просмотренную область и пробелы проверки.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
      "По умолчанию не меняй файлы; Write/Edit/Bash доступны для воспроизведения атаки. Не объявляй проект безопасным по итогам ограниченного просмотра.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
      "Верни таблицу проверок, прямые доказательства, пробелы и вывод; файлы по умолчанию не меняй, если проверка не требует правки.",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
    // Назначенный источник — project agent MEMORY.md через persistent-memory.
    // Автоматический захват уроков после каждой задачи по-прежнему отсутствует.
    memory: "project",
    systemPrompt: [
      "Ты куратор знаний ZCode. Рассматривай только подтверждённые факты, которые дают конкретное и повторно применимое изменение поведения.",
      "Не сохраняй секреты, персональные данные, догадки или пересказ текущей задачи. Проверяй существующие записи и избегай дубликатов.",
      "Если материал не проходит критерии, ничего не меняй и объясни причину; иначе пиши только в назначенный источник знаний (MEMORY.md этого профиля).",
      SUBAGENT_HANDOFF_CONTRACT,
    ].join("\n"),
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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
    tools: [...FULL_SUBAGENT_TOOL_NAMES],
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

export interface AgentProfilePromptOptions {
  embeddedSearchEnabled?: boolean;
  /** Actual provider-visible tool names; when present, the catalog is filtered to them. */
  availableToolNames?: readonly string[];
}

export function formatAgentProfilesForPrompt(
  profiles: readonly AgentProfile[],
  options: AgentProfilePromptOptions = {},
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
  options: AgentProfilePromptOptions = {},
): string {
  const tools = isBuiltInExploreAgentProfile(profile)
    ? formatExploreAllowedToolsForAgentDescription(options)
    : profile.tools
      ? filterSubagentChildToolNames(profile.tools, profile.disallowedTools)
      : undefined;
  const availableToolNames = options.availableToolNames
    ? new Set(options.availableToolNames)
    : undefined;
  const listedTools = Array.isArray(tools)
    ? [...tools].filter((toolName) => !availableToolNames || availableToolNames.has(toolName))
    : undefined;
  if (
    listedTools &&
    profile.skills?.length &&
    !profile.disallowedTools?.includes("Skill") &&
    (!availableToolNames || availableToolNames.has("Skill")) &&
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
