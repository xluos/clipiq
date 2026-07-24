import {
  type FunctionComponent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Check,
  Link2,
  Scissors,
  Search,
  Unlink,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useConfirm } from "./ConfirmDialog";
import {
  useIdentityEvidence,
  useLinkSpeakerTrackPerson,
  useMergePeople,
  useRenamePerson,
  useSplitPersonAppearance,
} from "../queries/identity";
import type {
  Person,
  PersonAppearance,
  SpeakerTrack,
  Video,
} from "../types";

type PeopleManagerProps = {
  videos: Video[];
};

function personLabel(person: Person, index: number): string {
  return person.displayName?.trim() || `未命名人物 ${index + 1}`;
}

function timeRange(startSec: number, endSec: number): string {
  const stamp = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const remain = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
  };
  return `${stamp(startSec)}–${stamp(endSec)}`;
}

function newManualPerson(): Person {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `person-manual-${random}`,
    status: "confirmed",
  };
}

export function PeopleManager({ videos }: PeopleManagerProps) {
  const confirm = useConfirm();
  const evidence = useIdentityEvidence();
  const rename = useRenamePerson();
  const merge = useMergePeople();
  const split = useSplitPersonAppearance();
  const linkSpeaker = useLinkSpeakerTrackPerson();
  const [query, setQuery] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState("");

  const people = useMemo(
    () => (evidence.data?.people || []).filter((person) => person.status !== "merged"),
    [evidence.data?.people],
  );
  const filteredPeople = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return people;
    return people.filter((person, index) =>
      personLabel(person, index).toLowerCase().includes(normalized)
      || person.id.toLowerCase().includes(normalized));
  }, [people, query]);
  const selectedPerson = people.find((person) => person.id === selectedPersonId) || null;
  const selectedIndex = selectedPerson
    ? people.findIndex((person) => person.id === selectedPerson.id)
    : -1;
  const videoById = useMemo(
    () => new Map(videos.map((video) => [video.id, video])),
    [videos],
  );
  const appearances = useMemo(
    () => (evidence.data?.appearances || [])
      .filter((appearance) => appearance.personId === selectedPersonId),
    [evidence.data?.appearances, selectedPersonId],
  );
  const linkedSpeakers = useMemo(
    () => (evidence.data?.speakerTracks || [])
      .filter((track) => track.personId === selectedPersonId),
    [evidence.data?.speakerTracks, selectedPersonId],
  );
  const relevantUnlinkedSpeakers = useMemo(() => {
    const videoIds = new Set(appearances.map((appearance) => appearance.videoId));
    return (evidence.data?.speakerTracks || []).filter((track) =>
      !track.personId && videoIds.has(track.videoId));
  }, [appearances, evidence.data?.speakerTracks]);

  useEffect(() => {
    if (!selectedPersonId || !people.some((person) => person.id === selectedPersonId)) {
      setSelectedPersonId(people[0]?.id || null);
    }
  }, [people, selectedPersonId]);

  useEffect(() => {
    setDraftName(selectedPerson?.displayName || "");
    setMergeTargetId("");
    setError("");
  }, [selectedPerson?.id, selectedPerson?.displayName]);

  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  };

  const saveName = () => {
    if (!selectedPerson || rename.isPending) return;
    const value = draftName.trim();
    if (value === (selectedPerson.displayName || "")) return;
    void run(() => rename.mutateAsync({
      personId: selectedPerson.id,
      displayName: value || undefined,
    }));
  };

  const mergeSelected = async () => {
    if (!selectedPerson || !mergeTargetId) return;
    const target = people.find((person) => person.id === mergeTargetId);
    if (!target) return;
    const accepted = await confirm({
      title: "合并人物",
      description: `“${personLabel(selectedPerson, selectedIndex)}”的出镜与说话人关联会并入“${personLabel(target, people.indexOf(target))}”。`,
      confirmLabel: "合并",
    });
    if (!accepted) return;
    const sourceId = selectedPerson.id;
    await run(async () => {
      await merge.mutateAsync({
        sourcePersonId: sourceId,
        targetPersonId: target.id,
      });
      setSelectedPersonId(target.id);
    });
  };

  const splitAppearance = async (appearance: PersonAppearance) => {
    const accepted = await confirm({
      title: "拆为新人物",
      description: `${videoById.get(appearance.videoId)?.title || "素材"} · ${timeRange(appearance.startSec, appearance.endSec)}`,
      confirmLabel: "拆分",
    });
    if (!accepted) return;
    await run(async () => {
      const created = await split.mutateAsync({
        appearanceId: appearance.id,
        person: newManualPerson(),
      });
      setSelectedPersonId(created.id);
    });
  };

  if (evidence.isLoading) {
    return (
      <div className="py-20 text-center text-[13px] text-slate-500">
        正在读取人物证据…
      </div>
    );
  }

  if (evidence.isError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
        {evidence.error instanceof Error ? evidence.error.message : "人物证据读取失败"}
      </div>
    );
  }

  if (people.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-8 py-16 text-center dark:border-slate-700 dark:bg-slate-900/30">
        <UsersRound className="mx-auto h-6 w-6 text-slate-400" strokeWidth={1.5} />
        <h2 className="mt-4 text-[16px] font-semibold text-slate-900 dark:text-slate-100">
          还没有人物
        </h2>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          素材完成分析后，清晰人脸会出现在这里。
        </p>
      </div>
    );
  }

  return (
    <div className="grid min-h-[560px] grid-cols-[300px_minmax(0,1fr)] overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
      <aside className="border-r border-slate-200 p-3 dark:border-slate-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索人物"
            className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] text-slate-900 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-700 dark:focus:ring-indigo-950"
          />
        </div>
        <div className="mt-3 space-y-1">
          {filteredPeople.map((person) => {
            const index = people.indexOf(person);
            const active = person.id === selectedPersonId;
            return (
              <button
                key={person.id}
                onClick={() => setSelectedPersonId(person.id)}
                className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left ${
                  active
                    ? "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100"
                    : "border-transparent text-slate-800 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
                }`}
              >
                <PersonThumbnail person={person} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {personLabel(person, index)}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10.5px] text-slate-500 dark:text-slate-400">
                    {person.appearanceCount || 0} 段出镜
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {selectedPerson && (
        <section className="min-w-0 p-6">
          <div className="flex items-start gap-4 border-b border-slate-200 pb-5 dark:border-slate-800">
            <PersonThumbnail person={selectedPerson} large />
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                人物档案
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveName();
                  }}
                  placeholder={personLabel(selectedPerson, selectedIndex)}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-[14px] font-medium text-slate-900 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-indigo-700 dark:focus:ring-indigo-950"
                />
                <button
                  onClick={saveName}
                  disabled={rename.isPending}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-[12.5px] text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                  保存名称
                </button>
              </div>
              <div className="mt-2 truncate font-mono text-[10.5px] text-slate-500 dark:text-slate-400">
                {selectedPerson.id}
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="mt-5 grid grid-cols-2 gap-5">
            <EvidenceSection title="出镜区间" count={appearances.length}>
              {appearances.length === 0 ? (
                <EmptyEvidence text="没有出镜区间" />
              ) : appearances.map((appearance) => (
                <AppearanceRow
                  key={appearance.id}
                  appearance={appearance}
                  video={videoById.get(appearance.videoId)}
                  pending={split.isPending}
                  onSplit={() => void splitAppearance(appearance)}
                />
              ))}
            </EvidenceSection>

            <div className="space-y-5">
              <EvidenceSection title="已关联说话人" count={linkedSpeakers.length}>
                {linkedSpeakers.length === 0 ? (
                  <EmptyEvidence text="没有人工关联" />
                ) : linkedSpeakers.map((track) => (
                  <SpeakerRow
                    key={track.id}
                    track={track}
                    video={videoById.get(track.videoId)}
                    action="unlink"
                    pending={linkSpeaker.isPending}
                    onAction={() => void run(() => linkSpeaker.mutateAsync({
                      speakerTrackId: track.id,
                      personId: undefined,
                    }))}
                  />
                ))}
              </EvidenceSection>

              {relevantUnlinkedSpeakers.length > 0 && (
                <EvidenceSection title="同素材未关联说话人" count={relevantUnlinkedSpeakers.length}>
                  {relevantUnlinkedSpeakers.map((track) => (
                    <SpeakerRow
                      key={track.id}
                      track={track}
                      video={videoById.get(track.videoId)}
                      action="link"
                      pending={linkSpeaker.isPending}
                      onAction={() => void run(() => linkSpeaker.mutateAsync({
                        speakerTrackId: track.id,
                        personId: selectedPerson.id,
                      }))}
                    />
                  ))}
                </EvidenceSection>
              )}
            </div>
          </div>

          <div className="mt-5 flex items-center gap-2 border-t border-slate-200 pt-5 dark:border-slate-800">
            <span className="text-[12.5px] text-slate-500 dark:text-slate-400">合并到</span>
            <select
              value={mergeTargetId}
              onChange={(event) => setMergeTargetId(event.target.value)}
              className="h-9 min-w-52 rounded-lg border border-slate-300 bg-white px-3 text-[12.5px] text-slate-800 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="">选择人物</option>
              {people.filter((person) => person.id !== selectedPerson.id).map((person) => (
                <option key={person.id} value={person.id}>
                  {personLabel(person, people.indexOf(person))}
                </option>
              ))}
            </select>
            <button
              onClick={() => void mergeSelected()}
              disabled={!mergeTargetId || merge.isPending}
              className="h-9 rounded-lg px-3 text-[12.5px] text-red-700 hover:bg-red-50 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-950/30"
            >
              合并人物
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

const PersonThumbnail: FunctionComponent<{ person: Person; large?: boolean }> = ({
  person,
  large,
}) => (
  <div className={`${large ? "h-14 w-14 rounded-xl" : "h-10 w-10 rounded-lg"} shrink-0 overflow-hidden border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800`}>
    {person.representativeThumbnailUrl ? (
      <img
        src={person.representativeThumbnailUrl}
        alt=""
        className="h-full w-full object-cover"
      />
    ) : (
      <div className="grid h-full w-full place-items-center">
        <UserRound className="h-4 w-4 text-slate-400" strokeWidth={1.5} />
      </div>
    )}
  </div>
);

const EvidenceSection: FunctionComponent<{
  title: string;
  count: number;
  children: ReactNode;
}> = ({ title, count, children }) => (
  <div>
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-400">
        {count}
      </span>
    </div>
    <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">{children}</div>
  </div>
);

function EmptyEvidence({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-[12px] text-slate-500 dark:border-slate-700 dark:text-slate-400">
      {text}
    </div>
  );
}

const AppearanceRow: FunctionComponent<{
  appearance: PersonAppearance;
  video?: Video;
  pending: boolean;
  onSplit: () => void;
}> = ({ appearance, video, pending, onSplit }) => (
  <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
    <div className="h-9 w-14 shrink-0 overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
      {appearance.thumbnailUrl && (
        <img src={appearance.thumbnailUrl} alt="" className="h-full w-full object-cover" />
      )}
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-[12px] text-slate-800 dark:text-slate-200">
        {video?.title || appearance.videoId}
      </div>
      <div className="mt-0.5 font-mono text-[10.5px] text-slate-500 dark:text-slate-400">
        {timeRange(appearance.startSec, appearance.endSec)}
        {appearance.manualLocked ? " · 人工确认" : ""}
      </div>
    </div>
    <button
      onClick={onSplit}
      disabled={pending}
      title="拆为新人物"
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      <Scissors className="h-3.5 w-3.5" strokeWidth={1.5} />
    </button>
  </div>
);

const SpeakerRow: FunctionComponent<{
  track: SpeakerTrack;
  video?: Video;
  action: "link" | "unlink";
  pending: boolean;
  onAction: () => void;
}> = ({ track, video, action, pending, onAction }) => (
  <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
    <div className="min-w-0 flex-1">
      <div className="truncate text-[12px] text-slate-800 dark:text-slate-200">
        {track.transcriptText || video?.title || track.speakerId}
      </div>
      <div className="mt-0.5 font-mono text-[10.5px] text-slate-500 dark:text-slate-400">
        {timeRange(track.startSec, track.endSec)} · {track.speakerId.split(":").slice(-2).join(":")}
      </div>
    </div>
    <button
      onClick={onAction}
      disabled={pending}
      title={action === "link" ? "关联到当前人物" : "取消关联"}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-100"
    >
      {action === "link"
        ? <Link2 className="h-3.5 w-3.5" strokeWidth={1.5} />
        : <Unlink className="h-3.5 w-3.5" strokeWidth={1.5} />}
    </button>
  </div>
);
