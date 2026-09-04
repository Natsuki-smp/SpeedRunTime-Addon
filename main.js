import { world, system, BlockPermutation } from "@minecraft/server";

/**
 * Speed Run — เปิด End Portal อัตโนมัติ + ตัวจับเวลาสปีดรันปราบมังกร
 * - แตะ End Portal Frame บล็อกไหนก็ได้ / เดินเข้ามาในระยะ 40 บล็อก -> วาง Eye of Ender ครบ 12 ช่องอัตโนมัติ
 * - ตัวจับเวลาในตัว: เริ่มนับเมื่อผู้เล่นขยับตัวครั้งแรก, หยุดทันทีที่ Ender Dragon ตาย
 * - ใช้แค่ @minecraft/server (stable API) + metadata.product_type = "addon" -> ไม่ปิด Achievements
 *   (ต้องไม่เปิด Cheats / Experimental toggles ในโลก)
 */

// ---------- ส่วน End Portal ----------

const FRAME_ID = "minecraft:end_portal_frame";
const PORTAL_ID = "minecraft:end_portal";
const SCAN_RADIUS = 40;
const VERTICAL_RANGE = 16;
const SCAN_INTERVAL_TICKS = 100; // ~5 วินาที
const BLOCKS_PER_YIELD = 800;

const RING_OFFSETS = [];
for (let dx = 0; dx <= 4; dx++) {
  for (let dz = 0; dz <= 4; dz++) {
    const isCorner = (dx === 0 || dx === 4) && (dz === 0 || dz === 4);
    const isEdge = dx === 0 || dx === 4 || dz === 0 || dz === 4;
    if (isEdge && !isCorner) RING_OFFSETS.push({ dx, dz });
  }
}

const activatedOrigins = new Set();
const scanningPlayers = new Set();

function originKey(dimId, x, y, z) {
  return `${dimId}:${x}:${y}:${z}`;
}

function tryCompleteRingAt(dimension, dimId, fx, fy, fz) {
  for (const { dx: odx, dz: odz } of RING_OFFSETS) {
    const originX = fx - odx;
    const originZ = fz - odz;
    const key = originKey(dimId, originX, fy, originZ);
    if (activatedOrigins.has(key)) continue;

    let allFrames = true;
    const positions = [];
    for (const { dx, dz } of RING_OFFSETS) {
      const pos = { x: originX + dx, y: fy, z: originZ + dz };
      let block;
      try {
        block = dimension.getBlock(pos);
      } catch {
        allFrames = false;
        break;
      }
      if (!block || block.typeId !== FRAME_ID) {
        allFrames = false;
        break;
      }
      positions.push(pos);
    }
    if (!allFrames) continue;

    const centerPos = { x: originX + 2, y: fy, z: originZ + 2 };
    const centerBlock = dimension.getBlock(centerPos);
    if (centerBlock && centerBlock.typeId === PORTAL_ID) {
      activatedOrigins.add(key);
      continue;
    }

    for (const pos of positions) {
      const b = dimension.getBlock(pos);
      if (!b) continue;
      const perm = b.permutation.withState("end_portal_eye_bit", true);
      b.setPermutation(perm);
    }

    for (let dx = 1; dx <= 3; dx++) {
      for (let dz = 1; dz <= 3; dz++) {
        const pos = { x: originX + dx, y: fy, z: originZ + dz };
        const b = dimension.getBlock(pos);
        if (b) b.setPermutation(BlockPermutation.resolve(PORTAL_ID));
      }
    }

    dimension.playSound("mob.endermen.portal", { x: fx, y: fy, z: fz });
    activatedOrigins.add(key);
    return true;
  }
  return false;
}

world.afterEvents.playerInteractWithBlock.subscribe((event) => {
  const { block } = event;
  if (!block || block.typeId !== FRAME_ID) return;
  system.runTimeout(() => {
    // เปิด End Portal อัตโนมัติแบบเงียบ ๆ ไม่ต้องแจ้งเตือนในแชท
    tryCompleteRingAt(block.dimension, block.dimension.id, block.location.x, block.location.y, block.location.z);
  }, 2);
});

function* scanPlayerArea(player) {
  const loc = player.location;
  const dimension = player.dimension;
  const dimId = dimension.id;
  const baseX = Math.floor(loc.x);
  const baseY = Math.floor(loc.y);
  const baseZ = Math.floor(loc.z);
  const radiusSq = SCAN_RADIUS * SCAN_RADIUS;
  let counter = 0;

  for (let y = baseY - VERTICAL_RANGE; y <= baseY + VERTICAL_RANGE; y++) {
    for (let x = baseX - SCAN_RADIUS; x <= baseX + SCAN_RADIUS; x++) {
      const dx = x - baseX;
      for (let z = baseZ - SCAN_RADIUS; z <= baseZ + SCAN_RADIUS; z++) {
        const dz = z - baseZ;
        if (dx * dx + dz * dz > radiusSq) continue;

        counter++;
        if (counter >= BLOCKS_PER_YIELD) {
          counter = 0;
          yield;
        }

        let block;
        try {
          block = dimension.getBlock({ x, y, z });
        } catch {
          continue;
        }
        if (block && block.typeId === FRAME_ID) {
          tryCompleteRingAt(dimension, dimId, x, y, z);
          // เปิด End Portal อัตโนมัติแล้ว - ไม่ต้องแจ้งเตือนในแชท
        }
      }
    }
  }
  scanningPlayers.delete(player.id);
}

system.runInterval(() => {
  for (const player of world.getPlayers()) {
    if (scanningPlayers.has(player.id)) continue;
    scanningPlayers.add(player.id);
    system.runJob(scanPlayerArea(player));
  }
}, SCAN_INTERVAL_TICKS);

// ---------- ส่วนตัวจับเวลาสปีดรัน ----------
// RTA ใช้เวลา "ร่วมกันทั้งเซิร์ฟเวอร์" : ทุกคนเห็นค่าเดียวกัน
// IGT ยังคงเป็นเวลาของผู้เล่นแต่ละคนเหมือนเดิม

const RTA_STATE_KEY = "srn:rtaState"; // idle | running | awaiting_return | win
const RTA_START_KEY = "srn:rtaStartMs";
const RTA_FINAL_KEY = "srn:rtaFinalMs";

const PLAYER_STATE_KEY = "dq:state"; // idle | running | awaiting_return | win
const START_TICK_KEY = "dq:startTick";
const FINAL_IGT_KEY = "dq:finalIgtMs";
const MOVE_THRESHOLD = 0.3;

const spawnBaseline = new Map();

function getRtaState() {
  return world.getDynamicProperty(RTA_STATE_KEY) ?? "idle";
}
function setRtaState(v) {
  world.setDynamicProperty(RTA_STATE_KEY, v);
}
function getPlayerState(player) {
  return player.getDynamicProperty(PLAYER_STATE_KEY) ?? "idle";
}
function setPlayerState(player, v) {
  player.setDynamicProperty(PLAYER_STATE_KEY, v);
}

function formatMs(ms) {
  const totalCentis = Math.floor(ms / 10);
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const hh = hours > 0 ? `${pad(hours)}:` : "";
  return `${hh}${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

function igtMsNow(startTick) {
  if (typeof startTick !== "number") return 0;
  return ((system.currentTick - startTick) / 20) * 1000;
}

function currentRtaMs() {
  const state = getRtaState();
  if (state === "win") return world.getDynamicProperty(RTA_FINAL_KEY) ?? 0;
  const startMs = world.getDynamicProperty(RTA_START_KEY);
  return typeof startMs === "number" && startMs > 0 ? Date.now() - startMs : 0;
}

function rtaIgtText(rtaMs, igtMs) {
  return `§b§lRTA: §f${formatMs(rtaMs)}\n§e§lIGT: §f${formatMs(igtMs)}`;
}

// คนแรกที่ขยับ = เริ่ม RTA ของทั้งเซิร์ฟเวอร์
function startSharedRta(player) {
  if (getRtaState() !== "idle") return;
  setRtaState("running");
  world.setDynamicProperty(RTA_START_KEY, Date.now());
  world.setDynamicProperty(RTA_FINAL_KEY, 0);
  world.sendMessage(`§c✦ §l§cSRN §r§f➤ §aRTA ของเซิร์ฟเวอร์เริ่มแล้ว! §7เริ่มโดย §f${player.name}`);
  for (const p of world.getPlayers()) {
    p.onScreenDisplay.setTitle("§e§l⏱ RTA Start");
    p.playSound("random.orb");
  }
}

function startPlayerIgt(player) {
  if (getPlayerState(player) !== "idle") return;
  setPlayerState(player, "running");
  player.setDynamicProperty(START_TICK_KEY, system.currentTick);
}

// มังกรตาย -> RTA ส่วนกลางยังเดินต่อจนมีคนกลับโลกเดิมหลังรับเครดิต
function onDragonDeath() {
  if (getRtaState() === "running") setRtaState("awaiting_return");
  for (const p of world.getPlayers()) {
    if (getPlayerState(p) === "running") setPlayerState(p, "awaiting_return");
    if (p.dimension.id === "minecraft:the_end") {
      p.onScreenDisplay.setTitle("§c§l🐉");
      p.onScreenDisplay.updateSubtitle("§7ปราบมังกรสำเร็จ ลงไปรับเครดิตแล้วกลับโลกเดิม");
      p.playSound("random.levelup");
    }
  }
}

// คนแรกที่กลับโลกเดิมหลังจบมังกร = หยุด RTA ร่วมกันทั้งเซิร์ฟเวอร์
function finishSharedRta(finisher) {
  if (getRtaState() !== "awaiting_return") return;
  const startMs = world.getDynamicProperty(RTA_START_KEY);
  const finalMs = typeof startMs === "number" ? Date.now() - startMs : 0;
  world.setDynamicProperty(RTA_FINAL_KEY, finalMs);
  setRtaState("win");

  world.sendMessage(`§d✦ §l§d${finisher.name} §r§f➤ §aWIN! §b RTA: §f${formatMs(finalMs)}`);
  for (const p of world.getPlayers()) {
    if (getPlayerState(p) === "running" || getPlayerState(p) === "awaiting_return") {
      const startTick = p.getDynamicProperty(START_TICK_KEY);
      const finalIgtMs = igtMsNow(startTick);
      p.setDynamicProperty(FINAL_IGT_KEY, finalIgtMs);
      setPlayerState(p, "win");
    }
    p.onScreenDisplay.setTitle("§a§lWin");
    p.onScreenDisplay.updateSubtitle(`§bRTA: §f${formatMs(finalMs)}`);
    p.playSound("random.levelup");
  }
}

// รีเซ็ตทั้งเซิร์ฟเวอร์ (เพื่อให้ RTA ร่วมกันเริ่มใหม่)
function resetTimer(player) {
  setRtaState("idle");
  world.setDynamicProperty(RTA_START_KEY, 0);
  world.setDynamicProperty(RTA_FINAL_KEY, 0);
  for (const p of world.getPlayers()) {
    setPlayerState(p, "idle");
    p.setDynamicProperty(START_TICK_KEY, 0);
    p.setDynamicProperty(FINAL_IGT_KEY, 0);
    spawnBaseline.set(p.id, { ...p.location });
    p.onScreenDisplay.setTitle("§a§l↺ รีเซ็ต RTA แล้ว");
  }
  world.sendMessage(`§a✦ §l§aSRN §r§f➤ ${player.name} รีเซ็ต RTA ของทั้งเซิร์ฟเวอร์แล้ว`);
}

world.afterEvents.playerSpawn.subscribe((event) => {
  const { player, initialSpawn } = event;
  if (!initialSpawn) return;
  if (!spawnBaseline.has(player.id)) spawnBaseline.set(player.id, { ...player.location });
});

// อัปเดต RTA เดียวกันให้ทุกคน ส่วน IGT ยังนับเฉพาะคนที่เริ่มวิ่งแล้ว
system.runInterval(() => {
  const rtaState = getRtaState();
  const rtaMs = currentRtaMs();

  for (const p of world.getPlayers()) {
    const playerState = getPlayerState(p);

    if (rtaState === "idle") {
      if (!spawnBaseline.has(p.id)) {
        spawnBaseline.set(p.id, { ...p.location });
      } else {
        const base = spawnBaseline.get(p.id);
        const loc = p.location;
        const dx = loc.x - base.x;
        const dy = loc.y - base.y;
        const dz = loc.z - base.z;
        if (dx * dx + dy * dy + dz * dz > MOVE_THRESHOLD * MOVE_THRESHOLD) {
          startSharedRta(p);
          startPlayerIgt(p);
        }
      }
    } else if (rtaState === "running" || rtaState === "awaiting_return") {
      // ใครเข้ามาทีหลังหรือเริ่มขยับภายหลัง จะมี IGT ของตัวเอง แต่ RTA ใช้ค่ากลางเดียวกัน
      if (playerState === "idle") {
        const base = spawnBaseline.get(p.id);
        if (base) {
          const loc = p.location;
          const dx = loc.x - base.x;
          const dy = loc.y - base.y;
          const dz = loc.z - base.z;
          if (dx * dx + dy * dy + dz * dz > MOVE_THRESHOLD * MOVE_THRESHOLD) startPlayerIgt(p);
        }
      }
    }

    const stateNow = getPlayerState(p);
    let igtMs = 0;
    if (stateNow === "win") igtMs = p.getDynamicProperty(FINAL_IGT_KEY) ?? 0;
    else if (stateNow === "running" || stateNow === "awaiting_return") igtMs = igtMsNow(p.getDynamicProperty(START_TICK_KEY));

    if (rtaState === "awaiting_return") {
      p.onScreenDisplay.setActionBar(`§7รับเครดิต...\n${rtaIgtText(rtaMs, igtMs)}`);
    } else if (rtaState === "win") {
      p.onScreenDisplay.setActionBar(`§a§lWin\n${rtaIgtText(rtaMs, igtMs)}`);
    } else if (rtaState === "running") {
      p.onScreenDisplay.setActionBar(rtaIgtText(rtaMs, igtMs));
    }
  }
}, 4);

world.afterEvents.entityDie.subscribe((event) => {
  const { deadEntity } = event;
  if (deadEntity.typeId !== "minecraft:ender_dragon") return;
  onDragonDeath();
});

world.afterEvents.playerDimensionChange.subscribe((event) => {
  const { player, toDimension } = event;
  if (toDimension.id !== "minecraft:overworld") return;
  if (getRtaState() !== "awaiting_return") return;
  finishSharedRta(player);
});

world.beforeEvents.chatSend.subscribe((event) => {
  const msg = event.message.trim().toLowerCase();
  if (msg === "resettimer" || msg === "!resettimer" || msg === "รีเซ็ตเวลา" || msg === "!รีเซ็ตเวลา") {
    event.cancel = true;
    const player = event.sender;
    system.run(() => resetTimer(player));
  }
});

world.afterEvents.worldLoad.subscribe(() => {
  world.sendMessage(
    "§c✦ §l§cSRN §r§f➤ พร้อมทำงาน: RTA ใช้ร่วมกันทั้งเซิร์ฟเวอร์, คนแรกที่ขยับจะเริ่มเวลา, IGT ยังเป็นรายผู้เล่น"
  );
});
