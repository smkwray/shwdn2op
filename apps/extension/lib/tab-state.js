import { roomHasActionableRequest, roomToSnapshot } from "./showdown-parser.js";

export const TAB_STATUS = {
  NO_SNAPSHOT: "no_snapshot",
  ROOM_AMBIGUOUS: "room_ambiguous",
  WAITING_OR_NOT_YOUR_TURN: "waiting_or_not_your_turn",
  STALE_SNAPSHOT: "stale_snapshot",
  READY: "ready",
  PROVIDER_ERROR: "provider_error"
};

export const DEFAULT_STALE_MS = 30_000;

function byMostRecent(a, b) {
  return (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0);
}

function buildMessage(status, room, meta = {}) {
  switch (status) {
    case TAB_STATUS.ROOM_AMBIGUOUS:
      return "Multiple battle rooms look actionable. Focus the intended battle tab before analyzing.";
    case TAB_STATUS.WAITING_OR_NOT_YOUR_TURN:
      if (room?.lastRequest?.teamPreview) {
        return "Team preview is visible. Local lead prediction should appear if the preview team has been captured.";
      }
      if (room?.lastRequest?.wait) {
        return "This battle is waiting for the opponent or an animation to finish.";
      }
      if (room?.lastRequest?.forceSwitch && (!room.legalActions || room.legalActions.length === 0)) {
        return "A forced switch is pending, but no legal switch choices were captured yet.";
      }
      return "No actionable choices are available for the currently focused battle yet.";
    case TAB_STATUS.STALE_SNAPSHOT:
      return `The latest captured battle state is stale (${Math.round((meta.ageMs ?? 0) / 1000)}s old).`;
    case TAB_STATUS.READY:
      if (room?.phase === "preview" || room?.lastRequest?.teamPreview) {
        return room ? `Ready to analyze team preview for ${room.format}.` : "Ready to analyze team preview.";
      }
      return room ? `Ready to analyze ${room.format} turn ${room.turn}.` : "Ready to analyze.";
    case TAB_STATUS.PROVIDER_ERROR:
      return meta.error ?? "The provider request failed.";
    case TAB_STATUS.NO_SNAPSHOT:
    default:
      return "No active Showdown battle snapshot was found for this tab yet.";
  }
}

export function buildTabSelection(tabState, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now();
  const rooms = [...(tabState?.rooms?.values?.() ?? [])].sort(byMostRecent);

  if (rooms.length === 0) {
    return {
      status: TAB_STATUS.NO_SNAPSHOT,
      room: null,
      snapshot: null,
      message: buildMessage(TAB_STATUS.NO_SNAPSHOT),
      actionableRoomIds: []
    };
  }

  const activeRoom = tabState?.activeRoomId ? tabState.rooms.get(tabState.activeRoomId) ?? null : null;
  const actionableRooms = rooms.filter((room) => roomHasActionableRequest(room));

  if (!activeRoom && actionableRooms.length > 1) {
    const room = actionableRooms[0];
    return {
      status: TAB_STATUS.ROOM_AMBIGUOUS,
      room,
      snapshot: roomToSnapshot(room),
      message: buildMessage(TAB_STATUS.ROOM_AMBIGUOUS, room),
      actionableRoomIds: actionableRooms.map((entry) => entry.roomId)
    };
  }

  const room = activeRoom ?? actionableRooms[0] ?? rooms[0] ?? null;
  if (!room) {
    return {
      status: TAB_STATUS.NO_SNAPSHOT,
      room: null,
      snapshot: null,
      message: buildMessage(TAB_STATUS.NO_SNAPSHOT),
      actionableRoomIds: []
    };
  }

  const ageMs = Math.max(0, now - (room.updatedAt ?? now));
  if (ageMs > staleMs) {
    return {
      status: TAB_STATUS.STALE_SNAPSHOT,
      room,
      snapshot: roomToSnapshot(room),
      message: buildMessage(TAB_STATUS.STALE_SNAPSHOT, room, { ageMs }),
      actionableRoomIds: actionableRooms.map((entry) => entry.roomId),
      ageMs
    };
  }

  if (roomHasActionableRequest(room)) {
    return {
      status: TAB_STATUS.READY,
      room,
      snapshot: roomToSnapshot(room),
      message: buildMessage(TAB_STATUS.READY, room),
      actionableRoomIds: actionableRooms.map((entry) => entry.roomId)
    };
  }

  return {
    status: TAB_STATUS.WAITING_OR_NOT_YOUR_TURN,
    room,
    snapshot: roomToSnapshot(room),
    message: buildMessage(TAB_STATUS.WAITING_OR_NOT_YOUR_TURN, room),
    actionableRoomIds: actionableRooms.map((entry) => entry.roomId)
  };
}
