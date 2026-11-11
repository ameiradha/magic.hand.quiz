import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

let handLandmarker: HandLandmarker | null = null;

export async function initHandDetection() {
  if (handLandmarker) return handLandmarker;

  let vision;
  try {
    vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm"
    );
  } catch (err) {
    console.warn("Failed loading versioned vision tasks, falling back to CDN root:", err);
    vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
    );
  }

  // Try GPU delegate first for hardware acceleration, with automatic fallback to CPU
  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    console.log("HandLandmarker successfully initialized with GPU delegate");
    return handLandmarker;
  } catch (gpuError) {
    console.warn("GPU delegate unavailable or failed on this device, falling back to CPU delegate:", gpuError);
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    console.log("HandLandmarker successfully initialized with CPU delegate");
    return handLandmarker;
  }
}

// Euclidean distance helper
function dist(p1: { x: number; y: number }, p2: { x: number; y: number }) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface HandFingersDetail {
  count: number;
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
}

export function detectFingersDetail(landmarks: any[]): HandFingersDetail {
  if (!landmarks || landmarks.length < 21) {
    return { count: 0, thumb: false, index: false, middle: false, ring: false, pinky: false };
  }

  const wrist = landmarks[0];

  // For Index, Middle, Ring, Pinky:
  // Using rotation-invariant distance to wrist + upward orientation check
  const index = 
    dist(landmarks[8], wrist) > dist(landmarks[6], wrist) * 1.15 ||
    (landmarks[8].y < landmarks[6].y && dist(landmarks[8], wrist) > dist(landmarks[5], wrist) * 1.05);

  const middle = 
    dist(landmarks[12], wrist) > dist(landmarks[10], wrist) * 1.15 ||
    (landmarks[12].y < landmarks[10].y && dist(landmarks[12], wrist) > dist(landmarks[9], wrist) * 1.05);

  const ring = 
    dist(landmarks[16], wrist) > dist(landmarks[14], wrist) * 1.15 ||
    (landmarks[16].y < landmarks[14].y && dist(landmarks[16], wrist) > dist(landmarks[13], wrist) * 1.05);

  const pinky = 
    dist(landmarks[20], wrist) > dist(landmarks[18], wrist) * 1.15 ||
    (landmarks[20].y < landmarks[18].y && dist(landmarks[20], wrist) > dist(landmarks[17], wrist) * 1.05);

  // Thumb detection:
  // Distance from thumb tip (4) to pinky base (17) vs thumb IP (3) to pinky base (17)
  const thumb = 
    dist(landmarks[4], landmarks[17]) > dist(landmarks[3], landmarks[17]) * 1.25 &&
    dist(landmarks[4], wrist) > dist(landmarks[2], wrist) * 1.1;

  let count4 = 0;
  if (index) count4++;
  if (middle) count4++;
  if (ring) count4++;
  if (pinky) count4++;

  let finalCount = count4;

  // Natural counting gesture support:
  if (count4 === 0 && thumb) {
    // 1. Thumbs-up alone = 1
    finalCount = 1;
  } else if (count4 === 1 && index && thumb) {
    // 2. Thumb + Index (L/gun gesture) = 2
    finalCount = 2;
  } else if (count4 === 2 && index && middle && thumb) {
    // 3. Thumb + Index + Middle (common in Malaysia, Germany, etc.) = 3
    finalCount = 3;
  } else if (count4 === 4) {
    // 4. All four non-thumb fingers extended = 4
    finalCount = 4;
  } else if (count4 === 3 && thumb && !pinky) {
    // 4 fingers: Thumb + Index + Middle + Ring = 4
    finalCount = 4;
  }

  // Constrain between 0 and 4 for quiz choices
  finalCount = Math.min(Math.max(finalCount, 0), 4);

  return {
    count: finalCount,
    thumb,
    index,
    middle,
    ring,
    pinky,
  };
}

export function countFingers(landmarks: any[]): number {
  return detectFingersDetail(landmarks).count;
}

export function drawHandOnCanvas(
  canvas: HTMLCanvasElement,
  landmarks: any[],
  mirrored: boolean = true
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!landmarks || landmarks.length < 21) return;

  // Connections between joints
  const connections = [
    [0, 1], [1, 2], [2, 3], [3, 4],       // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],       // index
    [0, 9], [9, 10], [10, 11], [11, 12],  // middle
    [0, 13], [13, 14], [14, 15], [15, 16],// ring
    [0, 17], [17, 18], [18, 19], [19, 20],// pinky
    [5, 9], [9, 13], [13, 17]             // palm
  ];

  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(78, 205, 196, 0.85)"; // kids-secondary
  ctx.lineCap = "round";

  for (const [i, j] of connections) {
    const p1 = landmarks[i];
    const p2 = landmarks[j];
    const x1 = mirrored ? (1 - p1.x) * w : p1.x * w;
    const y1 = p1.y * h;
    const x2 = mirrored ? (1 - p2.x) * w : p2.x * w;
    const y2 = p2.y * h;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Draw joints
  for (let i = 0; i < landmarks.length; i++) {
    const pt = landmarks[i];
    const x = mirrored ? (1 - pt.x) * w : pt.x * w;
    const y = pt.y * h;

    const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;

    ctx.beginPath();
    ctx.arc(x, y, isTip ? 8 : 4, 0, 2 * Math.PI);
    ctx.fillStyle = isTip ? "#FFE66D" : "#FF6B6B";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#FFFFFF";
    ctx.stroke();
  }

  ctx.restore();
}
