import type { LandmarkFrame } from './types';

const connections = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export function drawLandmarks(canvas: HTMLCanvasElement, frame: LandmarkFrame): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  for (const hand of frame.hands) {
    context.strokeStyle = '#a9f5dc';
    context.lineWidth = 2;
    for (const [start, end] of connections) {
      context.beginPath();
      context.moveTo(hand.landmarks[start][0] * width, hand.landmarks[start][1] * height);
      context.lineTo(hand.landmarks[end][0] * width, hand.landmarks[end][1] * height);
      context.stroke();
    }
    context.fillStyle = '#f5fffb';
    for (const [x, y] of hand.landmarks) {
      context.beginPath();
      context.arc(x * width, y * height, 3, 0, Math.PI * 2);
      context.fill();
    }
  }
}
