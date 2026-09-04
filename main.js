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

// ---------- ส่วนตัวจับเวลาสปีดรัน (แยกเวลาของแต่ละผู้เล่นอิสระจากกัน) ----------
// เก็บ state ไว้ที่ตัวผู้เล่นแต่ละคน (player dynamic property) แทนที่จะเก็บไว้ที่ world
// เพื่อให้ผู้เล่นแต่ละคนมีตัวจับเวลาของตัวเอง ไม่รวมกับคนอื่น

const STATE_KEY = "dq:state"; // "idle" | "running" | "awaiting_return" | "win"
const START_KEY = "dq:startMs";
const START_TICK_KEY = "dq:startTick";
const FINAL_KEY = "dq:finalMs";
const FINAL_IGT_KEY = "dq:finalIgtMs";
const MOVE_THRESHOLD = 0.3; // บล็อก

const spawnBaseline = new Map(); // playerId -> {x,y,z} ใช้เช็คว่าผู้เล่นคนนั้นขยับหรือยัง

function getState(player) {
  return player.getDynamicProperty(STATE_KEY) ?? "idle";
}
function setState(player, v) {
  player.setDynamicProperty(STATE_KEY, v);
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

function rtaIgtText(rtaMs, igtMs) {
  return `§b§lRTA: §f${formatMs(rtaMs)}\n§e§lIGT: §f${formatMs(igtMs)}`;
}

// ผู้เล่นคนนี้ขยับตัวเป็นครั้งแรก -> เริ่มจับเวลาของ "ตัวเอง" เท่านั้น
function startTimer(player) {
  setState(player, "running");
  player.setDynamicProperty(START_KEY, Date.now());
  player.setDynamicProperty(START_TICK_KEY, system.currentTick);
  player.onScreenDisplay.setTitle("§e§l⏱ Start");
  player.playSound("random.orb");
}

// มังกรตาย -> ใช้กับทุกคนที่กำลังจับเวลาอยู่และอยู่ใน The End ตอนนั้น
// แต่ละคนยังคงเดินเวลาของตัวเองแยกกันต่อไป (ยังไม่หยุด) จนกว่าจะกลับโลกเดิม
function onDragonDeath() {
  for (const p of world.getPlayers()) {
    if (p.dimension.id !== "minecraft:the_end") continue;
    if (getState(p) !== "running") continue;
    setState(p, "awaiting_return");
    p.onScreenDisplay.setTitle("§c§l🐉");
    p.onScreenDisplay.updateSubtitle("§7ปราบมังกรสำเร็จ ลงไปรับเครดิตแล้วกลับมาโลกเดิม เวลายังเดินอยู่");
    p.playSound("random.levelup");
  }
}

// ผู้เล่นคนนี้กลับถึงโลกเดิมหลังรับเครดิตแล้ว -> หยุดเวลาของ "ตัวเอง" แล้วประกาศ Win
function announceWin(player) {
  const startMs = player.getDynamicProperty(START_KEY);
  const startTick = player.getDynamicProperty(START_TICK_KEY);
  const finalMs = typeof startMs === "number" ? Date.now() - startMs : 0;
  const finalIgtMs = igtMsNow(startTick);
  setState(player, "win");
  player.setDynamicProperty(FINAL_KEY, finalMs);
  player.setDynamicProperty(FINAL_IGT_KEY, finalIgtMs);
  player.onScreenDisplay.setTitle("§a§lWin");
  player.onScreenDisplay.updateSubtitle(rtaIgtText(finalMs, finalIgtMs));
  player.playSound("random.levelup");
  world.sendMessage(
    `§d✦ §l§d${player.name} §r§f➤ Win! §b RTA: §f${formatMs(finalMs)} §e IGT: §f${formatMs(finalIgtMs)}`
  );
}

// รีเซ็ตเวลาของผู้เล่นที่พิมพ์คำสั่งเองเท่านั้น ไม่กระทบเวลาของคนอื่น
function resetTimer(player) {
  setState(player, "idle");
  player.setDynamicProperty(START_KEY, 0);
  player.setDynamicProperty(START_TICK_KEY, 0);
  player.setDynamicProperty(FINAL_KEY, 0);
  player.setDynamicProperty(FINAL_IGT_KEY, 0);
  spawnBaseline.set(player.id, { ...player.location });
  player.onScreenDisplay.setTitle("§a§l↺ รีเซ็ตตัวจับเวลาแล้ว");
  player.sendMessage("§a✦ §l§aจับเวลา §r§f➤ รีเซ็ตเรียบร้อย เดินเมื่อไหร่เริ่มนับใหม่ทันที");
}

// ผู้เล่นเข้าเซิร์ฟเวอร์ครั้งแรก -> ตั้งจุดอ้างอิงตำแหน่งของ "ตัวเอง" ไว้เช็คการขยับตัว
// (state เริ่มต้นเป็น idle เสมอ ต้องเดินก่อนเวลาของเขาถึงจะเริ่ม)
world.afterEvents.playerSpawn.subscribe((event) => {
  const { player, initialSpawn } = event;
  if (!initialSpawn) return;
  if (!spawnBaseline.has(player.id)) {
    spawnBaseline.set(player.id, { ...player.location });
  }
});

// เช็คการขยับตัวทุก ๆ 4 tick + อัปเดต actionbar ของผู้เล่นแต่ละคนตามเวลาของตัวเอง
system.runInterval(() => {
  for (const p of world.getPlayers()) {
    const state = getState(p);

    if (state === "idle") {
      if (!spawnBaseline.has(p.id)) {
        spawnBaseline.set(p.id, { ...p.location });
        continue;
      }
      const base = spawnBaseline.get(p.id);
      const loc = p.location;
      const dx = loc.x - base.x;
      const dy = loc.y - base.y;
      const dz = loc.z - base.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        startTimer(p);
      }
    } else if (state === "running") {
      const startMs = p.getDynamicProperty(START_KEY);
      const startTick = p.getDynamicProperty(START_TICK_KEY);
      if (typeof startMs === "number") {
        const rtaMs = Date.now() - startMs;
        const igtMs = igtMsNow(startTick);
        p.onScreenDisplay.setActionBar(rtaIgtText(rtaMs, igtMs));
      }
    } else if (state === "awaiting_return") {
      // เวลาของผู้เล่นคนนี้ยังเดินต่อจนกว่าจะกลับมาโลกเดิม
      const startMs = p.getDynamicProperty(START_KEY);
      const startTick = p.getDynamicProperty(START_TICK_KEY);
      if (typeof startMs === "number") {
        const rtaMs = Date.now() - startMs;
        const igtMs = igtMsNow(startTick);
        p.onScreenDisplay.setActionBar(`§7รับเครดิต...\n${rtaIgtText(rtaMs, igtMs)}`);
      }
    } else if (state === "win") {
      const finalMs = p.getDynamicProperty(FINAL_KEY) ?? 0;
      const finalIgtMs = p.getDynamicProperty(FINAL_IGT_KEY) ?? 0;
      p.onScreenDisplay.setActionBar(`§a§lWin\n${rtaIgtText(finalMs, finalIgtMs)}`);
    }
  }
}, 4);

// มังกรตาย -> เวลาของแต่ละคนที่อยู่ใน The End ยังเดินต่อ (ยังไม่ประกาศ Win จนกว่าจะลงไปรับเครดิตแล้วกลับสู่โลกเดิม)
// (ระบบ Over เมื่อผู้เล่นตายถูกเอาออกแล้ว - ตายระหว่างรันไม่ทำให้ตัวจับเวลาหยุด)
world.afterEvents.entityDie.subscribe((event) => {
  const { deadEntity } = event;
  if (deadEntity.typeId !== "minecraft:ender_dragon") return;
  onDragonDeath();
});

// ผู้เล่นคนไหนกลับจาก The End มาโลกเดิม หลังปราบมังกรสำเร็จ -> ประกาศ Win พร้อมเวลาของคนนั้น
world.afterEvents.playerDimensionChange.subscribe((event) => {
  const { player, toDimension } = event;
  if (toDimension.id !== "minecraft:overworld") return;
  if (getState(player) !== "awaiting_return") return;
  announceWin(player);
});

// พิมพ์ในแชท "resettimer" เพื่อรีเซ็ตตัวจับเวลาของ "ตัวเอง" เท่านั้น (ไม่ต้องใช้ cheats/คำสั่ง)
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
    "§b✦ §l§bSpeed Run §r§f➤ พร้อมทำงาน: เดินก้าวแรกเริ่มจับเวลาของตัวเอง (แยกกันคนละเวลา), ปราบมังกรแล้วกลับสู่โลกเดิมเพื่อรับ Win, พิมพ์ 'รีเซ็ตเวลา' เพื่อเริ่มใหม่"
  );
});
