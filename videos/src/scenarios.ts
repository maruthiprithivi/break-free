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
    title: 'Hand work to a cheaper model',
    steps: ['You ask, you choose', 'Stay in charge', 'You set the checks', 'Review and save'],
    sentences: [
      "You have a pile of work — writing, research, drafting — and you don't want to spend your frontier quota on all of it.",
      'You ask Break Free to hand a task to DeepSeek, while you stay in charge.',
      'You set the checks you want, and the gateway runs them, so a passing check is real.',
      'You review the result, and your quota barely moves.',
    ],
    image: 'delegate.png',
    audio: 'delegate.mp3',
    duration: 26.45,
  },
  {
    id: 'parallel',
    title: 'Fan a big job across vendors',
    steps: ['You ask, you choose', 'DeepSeek, Kimi, GLM', 'Verify and review on request', 'Collect in one pass'],
    sentences: [
      'A big job lands on your desk, and one task at a time would take all day.',
      'You ask Break Free to split it across DeepSeek, Kimi, and GLM, all working at once.',
      'You set the verification, and you ask a different vendor to review the important parts.',
      'You collect a tested, reviewed result in one pass.',
    ],
    image: 'parallel.png',
    audio: 'parallel.mp3',
    duration: 21.05,
  },
  {
    id: 'review',
    title: 'Get an independent second opinion',
    steps: ['A second opinion', 'A different model', 'A clear verdict', 'Decide with confidence'],
    sentences: [
      'Before you commit to an important decision, you want a second opinion.',
      'You ask Break Free to send it to a different model for an independent review.',
      'You get a clear verdict, with the exact points to look at.',
      'Confidence up, risk down.',
    ],
    image: 'review.png',
    audio: 'review.mp3',
    duration: 17.28,
  },
  {
    id: 'harness',
    title: 'Use another harness\u2019s strengths',
    steps: ["Another harness's strength", 'On your subscription', 'Keep moving', 'Collect the result'],
    sentences: [
      'Another harness has a strength you need for this task.',
      'You ask Break Free to open it in a terminal on your subscription, not API credits.',
      'It does the work while you move on to something else.',
      'You collect the result, and the subscription you already pay for does the heavy lifting.',
    ],
    image: 'harness.png',
    audio: 'harness.mp3',
    duration: 23.26,
  },
];
