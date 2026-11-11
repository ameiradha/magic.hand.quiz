import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

let handLandmarker: HandLandmarker | null = null;

export async function initHandDetection() {
  if (handLandmarker) return handLandmarker;

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
  });

  return handLandmarker;
}

export function countFingers(landmarks: any[]) {
  if (!landmarks || landmarks.length === 0) return 0;

  // Landmarks for finger tips and PIP joints
  // Thumb: 4 (tip), 3 (IP), 2 (MCP)
  // Index: 8 (tip), 6 (PIP)
  // Middle: 12 (tip), 10 (PIP)
  // Ring: 16 (tip), 14 (PIP)
  // Pinky: 20 (tip), 18 (PIP)

  let count = 0;

  // Thumb detection is tricky because it moves differently.
  // We check if the thumb tip is further from the palm center than the IP joint horizontally (for right hand)
  // or use a simpler vertical check if the hand is upright.
  // For simplicity in a quiz, we'll assume upright hand.
  
  // Index
  if (landmarks[8].y < landmarks[6].y) count++;
  // Middle
  if (landmarks[12].y < landmarks[10].y) count++;
  // Ring
  if (landmarks[16].y < landmarks[14].y) count++;
  // Pinky
  if (landmarks[20].y < landmarks[18].y) count++;

  // Thumb (special case)
  // Check if thumb tip is above the MCP joint (for upright hand)
  // Or check horizontal distance from index MCP
  const thumbTip = landmarks[4];
  const thumbBase = landmarks[2];
  if (thumbTip.y < thumbBase.y - 0.05) { // Simple vertical threshold
     // count++; // User said 1 finger = A, 2 = B, 3 = C, 4 = D. 
     // Usually people use index for 1, index+middle for 2, etc.
     // If they use thumb, it might be confusing. 
     // Let's stick to the 4 fingers (Index, Middle, Ring, Pinky) as the primary counters.
  }

  return count;
}
