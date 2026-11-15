import { listen } from '@tauri-apps/api/event';
import './dwell.css';

const circle = document.querySelector<SVGCircleElement>('.progress')!;
const circumference = 2 * Math.PI * 18;
circle.style.strokeDasharray = String(circumference);
void listen<number>('dwell-progress', ({ payload }) => {
  const progress = Math.min(1, Math.max(0, Number(payload) || 0));
  circle.style.strokeDashoffset = String(circumference * (1 - progress));
});
