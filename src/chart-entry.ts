// Chart.js pieces the page uses, tree-shaken by esbuild; Legend is omitted because the page draws its own.
import { CategoryScale, Chart, Filler, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip);
Object.assign(globalThis, { Chart });
