// Ported from solis-server (AGPL-3.0), internal/makino/message/path.go and
// internal/server/rpc/servers/message/common.go.
//
// Pure message-detail graph helpers. No database access, so the sandbox seed and
// the unit tests can use them without a server or a player.
export type MessageDetail = {
  MessageDetailId?: string;
  CharacterId?: string;
  Text?: string;
  StampAssetId?: string;
  ImageAssetId?: string;
  TelephoneId?: string;
  ChoiceText?: string;
  DelayMinutes?: number;
  ReadMinutes?: number;
  NextMessageDetailIds?: string[];
  Reliability?: number;
};

export type MessageMaster = {
  Id?: string;
  MessageGroupId?: string;
  CharacterId?: string;
  Details?: MessageDetail[] | null;
};

type Graph = {
  root: MessageDetail;
  details: Map<string, MessageDetail>;
};

export function detailId(detail: MessageDetail): string {
  return String(detail.MessageDetailId ?? '');
}

export function nextDetailIds(detail: MessageDetail): string[] {
  return Array.isArray(detail.NextMessageDetailIds)
    ? detail.NextMessageDetailIds.map(String)
    : [];
}

export function choiceText(detail: MessageDetail): string {
  return String(detail.ChoiceText ?? '');
}

function buildGraph(master: MessageMaster | null | undefined): Graph {
  const details = master?.Details;
  if (!master || !Array.isArray(details) || details.length === 0) {
    throw new Error('message has no detail graph');
  }

  const byId = new Map<string, MessageDetail>();
  const indegree = new Map<string, number>();
  for (const detail of details) {
    const id = detailId(detail);
    if (!id || byId.has(id)) {
      throw new Error(`message ${String(master.Id ?? '')} has an invalid detail identity`);
    }
    byId.set(id, detail);
    indegree.set(id, 0);
  }
  for (const detail of details) {
    for (const nextId of nextDetailIds(detail)) {
      if (!byId.has(nextId)) {
        throw new Error(
          `message ${String(master.Id ?? '')} references missing detail ${JSON.stringify(nextId)}`,
        );
      }
      indegree.set(nextId, (indegree.get(nextId) ?? 0) + 1);
    }
  }

  let root: MessageDetail | null = null;
  for (const [id, degree] of indegree) {
    if (degree !== 0) continue;
    if (root) throw new Error(`message ${String(master.Id ?? '')} has multiple roots`);
    root = byId.get(id) ?? null;
  }
  if (!root) throw new Error(`message ${String(master.Id ?? '')} has no root`);
  return { root, details: byId };
}

/**
 * Follow the graph using the first listed option at each choice.
 * Returns the choice detail ids and the terminal detail.
 */
export function firstPath(master: MessageMaster | null | undefined): {
  selections: string[];
  terminal: MessageDetail;
} {
  const graph = buildGraph(master);
  const selections: string[] = [];
  const visited = new Set<string>();
  let current = graph.root;

  for (;;) {
    const id = detailId(current);
    if (visited.has(id)) {
      throw new Error(`message ${String(master?.Id ?? '')} detail graph contains a cycle`);
    }
    visited.add(id);

    const nextIds = nextDetailIds(current);
    if (nextIds.length === 0) return { selections, terminal: current };

    const next = graph.details.get(nextIds[0]!);
    if (!next) throw new Error(`message ${String(master?.Id ?? '')} references missing detail`);
    if (choiceText(next) !== '') selections.push(detailId(next));
    current = next;
  }
}

/**
 * Validate a finished message history and find one complete route represented
 * by its selections. Extra choices from replayed alternate routes are accepted
 * because SaveHistory stores their union.
 */
export function existingHistoryPath(
  master: MessageMaster | null | undefined,
  selectionIds: readonly string[],
): MessageDetail {
  const graph = buildGraph(master);
  const selected = new Set<string>();
  for (const selectionId of selectionIds) {
    const detail = graph.details.get(selectionId);
    if (!detail || choiceText(detail) === '') {
      throw new Error(
        `message ${String(master?.Id ?? '')} selection ${JSON.stringify(selectionId)} is not a choice`,
      );
    }
    if (selected.has(selectionId)) {
      throw new Error(
        `message ${String(master?.Id ?? '')} selection ${JSON.stringify(selectionId)} is duplicated`,
      );
    }
    selected.add(selectionId);
  }

  const terminal = selectedPathTerminal(graph.root, graph.details, selected, new Set());
  if (!terminal) {
    throw new Error(
      `message ${String(master?.Id ?? '')} selections contain no complete path`,
    );
  }
  return terminal;
}

function selectedPathTerminal(
  current: MessageDetail,
  details: Map<string, MessageDetail>,
  selected: Set<string>,
  visited: Set<string>,
): MessageDetail | null {
  const id = detailId(current);
  if (visited.has(id)) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(id);

  const nextIds = nextDetailIds(current);
  if (nextIds.length === 0) return current;

  for (const nextId of nextIds) {
    const next = details.get(nextId);
    if (!next) continue;
    if (choiceText(next) !== '') {
      if (!selected.has(nextId)) continue;
    } else if (nextIds.length > 1) {
      continue;
    }
    const terminal = selectedPathTerminal(next, details, selected, nextVisited);
    if (terminal) return terminal;
  }
  return null;
}

/**
 * Resolve the complete route described by `selectionIds`, optionally stopping
 * at `stopId`. Throws when the selections do not form exactly one route.
 */
export function resolveMessageDetails(
  master: MessageMaster | null | undefined,
  selectionIds: readonly string[],
  stopId: string,
): { path: MessageDetail[]; selections: string[] } {
  const details = master?.Details;
  if (!master || !Array.isArray(details) || details.length === 0) {
    throw new Error('message has no detail graph');
  }

  const byId = new Map<string, MessageDetail>();
  const indegree = new Map<string, number>();
  for (const detail of details) {
    const id = detailId(detail);
    if (!id || byId.has(id)) {
      throw new Error('message detail graph has an invalid identity');
    }
    byId.set(id, detail);
    indegree.set(id, 0);
  }
  for (const detail of details) {
    for (const nextId of nextDetailIds(detail)) {
      if (!byId.has(nextId)) {
        throw new Error(
          `message detail ${JSON.stringify(detailId(detail))} references missing detail ${JSON.stringify(nextId)}`,
        );
      }
      indegree.set(nextId, (indegree.get(nextId) ?? 0) + 1);
    }
  }

  let root: MessageDetail | null = null;
  for (const [id, degree] of indegree) {
    if (degree !== 0) continue;
    if (root) throw new Error('message detail graph has multiple roots');
    root = byId.get(id) ?? null;
  }
  if (!root) throw new Error('message detail graph has no root');

  const selected = new Set<string>();
  for (const id of selectionIds) {
    const detail = byId.get(id);
    if (!detail || choiceText(detail) === '') {
      throw new Error(`message selection ${JSON.stringify(id)} is not a choice in this message`);
    }
    if (selected.has(id)) {
      throw new Error(`message selection ${JSON.stringify(id)} is duplicated`);
    }
    selected.add(id);
  }

  let current = root;
  const path: MessageDetail[] = [];
  const visited = new Set<string>();
  const usedSelections = new Set<string>();
  const pathSelections: string[] = [];

  for (;;) {
    const currentId = detailId(current);
    if (visited.has(currentId)) {
      throw new Error('message detail graph contains a cycle');
    }
    visited.add(currentId);
    path.push(current);

    if (stopId !== '' && currentId === stopId) {
      if (usedSelections.size !== selected.size) {
        throw new Error(`message selections do not reach detail ${JSON.stringify(stopId)}`);
      }
      return { path, selections: pathSelections };
    }

    const nextIds = nextDetailIds(current);
    if (nextIds.length === 0) {
      if (stopId !== '') {
        throw new Error(
          `message detail ${JSON.stringify(stopId)} is not reachable with the selected path`,
        );
      }
      if (usedSelections.size !== selected.size) {
        throw new Error('message selections do not form one complete path');
      }
      return { path, selections: pathSelections };
    }

    let nextId = nextIds[0]!;
    if (nextIds.length > 1) {
      let selectedCount = 0;
      for (const candidateId of nextIds) {
        const candidate = byId.get(candidateId);
        if (!candidate || choiceText(candidate) === '') {
          throw new Error(
            `message detail ${JSON.stringify(currentId)} has a non-choice branch`,
          );
        }
        if (selected.has(candidateId)) {
          nextId = candidateId;
          selectedCount++;
        }
      }
      if (selectedCount !== 1) {
        throw new Error(
          `message detail ${JSON.stringify(currentId)} requires exactly one selected choice`,
        );
      }
      usedSelections.add(nextId);
      pathSelections.push(nextId);
    } else {
      const next = byId.get(nextId);
      if (!next) throw new Error(`message detail ${JSON.stringify(nextId)} is missing`);
      if (choiceText(next) !== '') {
        if (!selected.has(nextId)) {
          throw new Error(
            `message detail ${JSON.stringify(currentId)} requires its selected choice`,
          );
        }
        usedSelections.add(nextId);
        pathSelections.push(nextId);
      }
    }
    const following = byId.get(nextId);
    if (!following) throw new Error(`message detail ${JSON.stringify(nextId)} is missing`);
    current = following;
  }
}

/**
 * Saved progress may only move forward along the same route. An empty
 * `lastMessageDetailId` means no progress has been saved yet.
 */
export function validateMessageProgressExtension(
  master: MessageMaster | null | undefined,
  lastMessageDetailId: string,
  selectionIds: readonly string[],
  newPath: readonly MessageDetail[],
): void {
  if (lastMessageDetailId === '') {
    if (selectionIds.length !== 0) {
      throw new Error('message selections exist without saved progress');
    }
    return;
  }

  const saved = resolveMessageDetails(master, selectionIds, lastMessageDetailId).path;
  if (newPath.length < saved.length) {
    throw new Error('message progress cannot be rewound');
  }
  for (let index = 0; index < saved.length; index++) {
    if (detailId(newPath[index]!) !== detailId(saved[index]!)) {
      throw new Error('message progress cannot switch paths');
    }
  }
}

/** Lexicographically greatest terminal detail id, matching Solis. */
export function terminalMessageDetailId(
  master: MessageMaster | null | undefined,
): string {
  let result = '';
  for (const detail of master?.Details ?? []) {
    if (nextDetailIds(detail).length === 0) {
      const id = detailId(detail);
      if (id > result) result = id;
    }
  }
  return result;
}

/** Union of two selection lists, de-duplicated and sorted. */
export function mergeSortedStrings(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set([...left, ...right])].sort();
}
