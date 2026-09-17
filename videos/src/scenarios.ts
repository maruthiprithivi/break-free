export interface ScenarioData {
  id: string;
  title: string;
  steps: string[];
  sentences: string[];
  image: string;
  audio: string;
  duration: number;
}

export const scenarios: ScenarioData[] = [
  {
    id: 'delegate',
    title: 'Ship features on cheaper models',
    steps: ['Delegate to DeepSeek', 'Stay in charge', 'Real verification', 'Commit and save'],
    sentences: [
      "Building a feature in Claude Code, but you don't want to burn your frontier quota.",
      'Break Free hands the implementation to DeepSeek, while you stay in charge.',
      'The gateway runs the test command itself, so a passing check is real.',
      'You review the diff, commit, and your quota barely moves.',
    ],
    image: 'delegate.png',
    audio: 'delegate.mp3',
    duration: 25.75,
  },
  {
    id: 'parallel',
    title: 'Parallel refactor across vendors',
    steps: ['Split across vendors', 'DeepSeek, Kimi, GLM', 'Verify and review', 'Merge in one pass'],
    sentences: [
      'A dependency upgrade touches twenty files across the codebase.',
      'Break Free splits the work across DeepSeek, Kimi, and GLM, all in parallel.',
      'Every change is verified by the gateway, then reviewed by a different vendor.',
      'You merge a tested, reviewed migration in one pass.',
    ],
    image: 'parallel.png',
    audio: 'parallel.mp3',
    duration: 25.34,
  },
  {
    id: 'review',
    title: 'Independent review before merge',
    steps: ['A second opinion', 'A different vendor', 'A clear verdict', 'Merge with confidence'],
    sentences: [
      'Before merging a risky auth change, you want a second opinion.',
      'Break Free sends the diff to a different model for independent review.',
      'You get a clear verdict, with the exact files and lines to look at.',
      'Confidence up, risk down, and you merge.',
    ],
    image: 'review.png',
    audio: 'review.mp3',
    duration: 22.85,
  },
  {
    id: 'harness',
    title: 'Hand work to another harness',
    steps: ["Use Codex's strength", 'On your subscription', 'Keep moving', 'Collect the result'],
    sentences: [
      'Codex is better at this front-end mockup than your current model.',
      'Break Free opens Codex in a terminal on your subscription, not API credits.',
      'It does the work while you move on to something else.',
      'You collect the result, and the subscription you already pay for does the heavy lifting.',
    ],
    image: 'harness.png',
    audio: 'harness.mp3',
    duration: 18.36,
  },
];
