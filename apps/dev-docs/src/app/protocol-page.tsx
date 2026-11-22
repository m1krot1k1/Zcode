import { useMemo, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpenText,
  Boxes,
  Braces,
  GitCompareArrows,
  Hash,
  LinkIcon,
  Network,
} from "lucide-react";
import {
  concepts,
  flows,
  protocolSurfaces,
  structures,
  type Concept,
  type FieldDoc,
  type StructureDoc,
} from "@/data/protocolDocs.js";
import {
  conceptById,
  kindClassName,
  kindLabel,
  matchesConcept,
  matchesStructure,
  normalizeText,
} from "./docs-model.js";

interface ProtocolViewProps {
  activeConceptId: string;
  onSelectConcept: (conceptId: string) => void;
  query: string;
}

export function ProtocolView({ activeConceptId, onSelectConcept, query }: ProtocolViewProps) {
  const normalizedQuery = normalizeText(query);
  const activeConcept = conceptById.get(activeConceptId) ?? concepts[0];

  const filteredStructures = useMemo(
    () => structures.filter((structure) => matchesStructure(structure, normalizedQuery)),
    [normalizedQuery],
  );

  const filteredConcepts = useMemo(
    () => concepts.filter((concept) => matchesConcept(concept, normalizedQuery)),
    [normalizedQuery],
  );

  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
      <aside className="hidden lg:block">
        <div className="sticky top-20 rounded-lg border border-card-border bg-card p-2">
          <div className="px-2 py-1 text-ui-sm font-medium text-foreground-subtle">结构目录</div>
          <nav className="mt-1 flex flex-col gap-1">
            {structures.map((structure) => (
              <a
                className="rounded-md px-2 py-1.5 text-ui-sm text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
                href={`#${structure.id}`}
                key={structure.id}
              >
                {structure.title}
              </a>
            ))}
          </nav>
        </div>
      </aside>

      <div className="min-w-0 space-y-4">
        <section className="rounded-lg border border-card-border bg-card p-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-brand">
                <GitCompareArrows className="size-4" />
                数据结构迁移
              </div>
              <h2 className="text-ui-lg font-medium">
                从 `traceId` 混用到 `traceId + inputId` 双轴模型
              </h2>
              <p className="mt-2 max-w-3xl text-ui-base leading-6 text-foreground-subtle">
                这次变更把“观测链路”和“用户输入归属”拆开：`traceId`
                保持日志与协议事件追踪，`inputId` 负责每次发送、排队、stop 和终态收口。`sessionId`
                仍是 agent server 生成的会话主键。
              </p>
            </div>
            <div className="grid min-w-56 gap-2 rounded-lg border border-border bg-surface p-3 text-ui-sm">
              <Metric label="结构" value={String(structures.length)} />
              <Metric label="概念" value={String(concepts.length)} />
              <Metric label="协议面" value={String(protocolSurfaces.length)} />
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <SummaryCard
            icon={<Hash className="size-4" />}
            title="sessionId"
            body="会话主键，server 生成。UI/task 进入 ZCode Protocol 前必须拿到它。"
            conceptId="sessionId"
            onSelect={onSelectConcept}
          />
          <SummaryCard
            icon={<Network className="size-4" />}
            title="traceId"
            body="观测链路，UUID 格式，不再用作每次 prompt 的 run id。"
            conceptId="traceId"
            onSelect={onSelectConcept}
          />
          <SummaryCard
            icon={<Boxes className="size-4" />}
            title="inputId"
            body="每次用户输入的归属，贯穿 send、turn event、stream event 和 UI 收口。"
            conceptId="inputId"
            onSelect={onSelectConcept}
          />
        </section>

        <section className="rounded-lg border border-card-border bg-card p-4" id="flow">
          <div className="mb-3 flex items-center gap-2">
            <Braces className="size-4 text-brand" />
            <h2 className="text-ui-base font-medium">发送链路</h2>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {flows.map((step, index) => (
              <div className="rounded-lg border border-border bg-surface p-3" key={step.id}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-ui-sm text-foreground-subtle">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-ui-sm text-foreground-subtle">
                    {step.actor}
                  </span>
                </div>
                <h3 className="text-ui-base font-medium">{step.title}</h3>
                <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{step.detail}</p>
                <ConceptLinks
                  ids={step.conceptIds}
                  activeId={activeConceptId}
                  onSelect={onSelectConcept}
                />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          {filteredStructures.map((structure) => (
            <StructureSection
              activeConceptId={activeConceptId}
              key={structure.id}
              onSelectConcept={onSelectConcept}
              structure={structure}
            />
          ))}
          {filteredStructures.length === 0 ? (
            <div className="rounded-lg border border-card-border bg-card p-4 text-ui-base text-foreground-subtle">
              没有匹配的数据结构。
            </div>
          ) : null}
        </section>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <ConceptPanel
          activeConcept={activeConcept}
          activeConceptId={activeConceptId}
          filteredConcepts={filteredConcepts}
          onSelect={onSelectConcept}
        />
        <ProtocolPanel activeConceptId={activeConceptId} onSelect={onSelectConcept} />
      </aside>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function SummaryCard({
  body,
  conceptId,
  icon,
  onSelect,
  title,
}: {
  body: string;
  conceptId: string;
  icon: ReactNode;
  onSelect: (conceptId: string) => void;
  title: string;
}) {
  return (
    <a
      className="group rounded-lg border border-card-border bg-card p-4 hover:border-border-hover hover:bg-card-selected"
      href={`#concept-${conceptId}`}
      onClick={() => onSelect(conceptId)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-border bg-surface text-brand">
          {icon}
        </div>
        <ArrowRight className="size-4 text-foreground-subtlest group-hover:text-foreground" />
      </div>
      <h3 className="font-mono text-ui-base font-medium">{title}</h3>
      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{body}</p>
    </a>
  );
}

function StructureSection({
  activeConceptId,
  onSelectConcept,
  structure,
}: {
  activeConceptId: string;
  onSelectConcept: (conceptId: string) => void;
  structure: StructureDoc;
}) {
  return (
    <article
      className="scroll-mt-20 rounded-lg border border-card-border bg-card"
      id={structure.id}
    >
      <div className="border-b border-border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <BookOpenText className="size-4 text-brand" />
          <h2 className="text-ui-base font-medium">{structure.title}</h2>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle">
            {structure.path}
          </span>
        </div>
        <p className="text-ui-base leading-6 text-foreground-subtle">{structure.purpose}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {structure.oldShape ? (
            <CodePanel label="旧结构" value={structure.oldShape} />
          ) : (
            <CodePanel label="旧结构" value="无直接旧结构，属于新增协议结构说明。" />
          )}
          <CodePanel label="新结构" value={structure.newShape} />
        </div>
        <div className="mt-3 rounded-lg border border-border bg-accent/60 p-3 text-ui-sm leading-5 text-foreground">
          {structure.migration}
        </div>
      </div>
      <FieldTable
        activeConceptId={activeConceptId}
        fields={structure.fields}
        onSelectConcept={onSelectConcept}
      />
    </article>
  );
}

function CodePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-ui-sm font-medium text-foreground-subtle">{label}</div>
      <code className="block whitespace-pre-wrap break-words font-mono text-ui-sm leading-5 text-foreground">
        {value}
      </code>
    </div>
  );
}

function FieldTable({
  activeConceptId,
  fields,
  onSelectConcept,
}: {
  activeConceptId: string;
  fields: FieldDoc[];
  onSelectConcept: (conceptId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] border-collapse text-left text-ui-sm">
        <thead className="bg-surface text-foreground-subtle">
          <tr>
            <Th>字段</Th>
            <Th>类型</Th>
            <Th>状态</Th>
            <Th>含义</Th>
            <Th>Owner</Th>
            <Th>关联概念</Th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr className="border-t border-border align-top" key={`${field.name}-${field.source}`}>
              <td className="w-44 p-3">
                <div className="font-mono text-foreground">{field.name}</div>
                {field.oldName ? (
                  <div className="mt-1 font-mono text-foreground-subtlest">
                    old: {field.oldName}
                  </div>
                ) : null}
              </td>
              <td className="w-56 p-3 font-mono text-foreground-subtle">{field.type}</td>
              <td className="w-24 p-3">
                <RequiredBadge required={field.required} />
              </td>
              <td className="min-w-80 p-3">
                <p className="leading-5 text-foreground">{field.meaning}</p>
                {field.notes ? (
                  <p className="mt-1 leading-5 text-foreground-subtle">{field.notes}</p>
                ) : null}
                <p className="mt-1 font-mono text-ui-xs leading-5 text-foreground-subtlest">
                  {field.source}
                </p>
              </td>
              <td className="w-36 p-3 text-foreground-subtle">{field.owner}</td>
              <td className="w-56 p-3">
                <ConceptLinks
                  activeId={activeConceptId}
                  ids={field.conceptIds}
                  onSelect={onSelectConcept}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="border-b border-border px-3 py-2 font-medium">{children}</th>;
}

function RequiredBadge({ required }: { required: FieldDoc["required"] }) {
  const label = required === "required" ? "必填" : required === "optional" ? "可选" : "兼容";
  const className =
    required === "required"
      ? "border-brand/35 bg-brand/12 text-foreground"
      : required === "optional"
        ? "border-border bg-surface text-foreground-subtle"
        : "border-warning/35 bg-warning/12 text-foreground";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 ${className}`}>{label}</span>
  );
}

function ConceptLinks({
  activeId,
  ids,
  onSelect,
}: {
  activeId: string;
  ids: string[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const concept = conceptById.get(id);
        const active = id === activeId;
        return (
          <a
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-ui-xs ${
              active
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border bg-tag text-foreground"
            }`}
            href={`#concept-${id}`}
            key={id}
            onClick={() => onSelect(id)}
            title={concept?.summary ?? id}
          >
            <LinkIcon className="size-3" />
            {concept?.name ?? id}
          </a>
        );
      })}
    </div>
  );
}

function ConceptPanel({
  activeConcept,
  activeConceptId,
  filteredConcepts,
  onSelect,
}: {
  activeConcept: Concept | undefined;
  activeConceptId: string;
  filteredConcepts: Concept[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card">
      <div className="border-b border-border p-3">
        <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-brand">
          <Hash className="size-4" />
          概念索引
        </div>
        {activeConcept ? (
          <div className="scroll-mt-20" id={`concept-${activeConcept.id}`}>
            <div className="mt-2 flex items-center gap-2">
              <code className="font-mono text-ui-base font-medium">{activeConcept.name}</code>
              <span
                className={`rounded-full border px-2 py-0.5 text-ui-xs ${kindClassName[activeConcept.kind]}`}
              >
                {kindLabel[activeConcept.kind]}
              </span>
            </div>
            <p className="mt-2 text-ui-sm leading-5 text-foreground-subtle">
              {activeConcept.summary}
            </p>
            <dl className="mt-3 grid gap-2 text-ui-sm">
              <DetailRow label="生命周期" value={activeConcept.lifecycle} />
              <DetailRow label="Owner" value={activeConcept.owner} />
              <DetailRow label="来源" value={activeConcept.source} mono />
            </dl>
            {activeConcept.related.length > 0 ? (
              <ConceptLinks
                activeId={activeConceptId}
                ids={activeConcept.related}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="max-h-[420px] overflow-y-auto p-2">
        {filteredConcepts.map((concept) => (
          <a
            className={`mb-1 block rounded-md px-2 py-1.5 text-ui-sm ${
              concept.id === activeConceptId
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
            }`}
            href={`#concept-${concept.id}`}
            key={concept.id}
            onClick={() => onSelect(concept.id)}
          >
            <span className="font-mono">{concept.name}</span>
            <span className="ml-2 text-foreground-subtlest">{kindLabel[concept.kind]}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function DetailRow({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div>
      <dt className="text-foreground-subtlest">{label}</dt>
      <dd className={`mt-0.5 leading-5 text-foreground ${mono ? "font-mono text-ui-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function ProtocolPanel({
  activeConceptId,
  onSelect,
}: {
  activeConceptId: string;
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card p-3">
      <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
        <Network className="size-4" />
        @zcode/protocol
      </div>
      <div className="space-y-2">
        {protocolSurfaces.map((surface) => (
          <div className="rounded-lg border border-border bg-surface p-3" key={surface.id}>
            <h3 className="text-ui-base font-medium">{surface.title}</h3>
            <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{surface.summary}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {surface.fields.map((field) => (
                <span
                  className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
                  key={field}
                >
                  {field}
                </span>
              ))}
            </div>
            <ConceptLinks activeId={activeConceptId} ids={surface.conceptIds} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </section>
  );
}
