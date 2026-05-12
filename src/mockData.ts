import { Project, AnalysisNode, AnalysisReport } from "./types";

export const generateMockNodes = (duration: number = 180): AnalysisNode[] => {
  return [
    {
      id: "node-1",
      startSec: 0,
      endSec: Math.min(15, duration),
      title: "Hook: Catchy Introduction",
      nodeTypes: ["shot_change", "info_point"],
      shotDescription: "Close up of the host looking excited, holding a mysterious object.",
      visualElements: ["Host face", "Mysterious black box", "Studio lighting"],
      audioElements: ["Upbeat intro music", "Host speaking loudly: 'You won't believe what's inside!'"],
      editIntent: "Grab viewer's attention immediately within the first 3 seconds.",
      emotionLabel: "Excitement",
      emotionIntensity: 8,
      narrativeFunction: "Hook",
      confidence: 0.95,
      isHighlight: true,
      note: "Great hook, consider using this clip for trailer."
    },
    {
      id: "node-2",
      startSec: Math.min(15, duration),
      endSec: Math.min(45, duration),
      title: "Context: Explaining the premise",
      nodeTypes: ["info_point", "emotion_turn"],
      shotDescription: "Medium shot of host sitting at a table, explaining the back story.",
      visualElements: ["Table", "Graphs overlay"],
      audioElements: ["Music volume drops", "Host voiceover explaining stats"],
      editIntent: "Provide necessary background context for the climax.",
      emotionLabel: "Curiosity",
      emotionIntensity: 5,
      narrativeFunction: "Development",
      confidence: 0.88,
      isHighlight: false
    },
    {
      id: "node-3",
      startSec: Math.min(45, duration),
      endSec: Math.min(120, duration),
      title: "The Reveal: Opening the box",
      nodeTypes: ["shot_change", "emotion_turn", "audio_change"],
      shotDescription: "Quick cuts between host's face and the object inside the box.",
      visualElements: ["Glowing object", "Host wide eyes"],
      audioElements: ["Suspenseful riser", "Whoosh sound effects"],
      editIntent: "Build suspense and deliver the payoff.",
      emotionLabel: "Surprise",
      emotionIntensity: 9,
      narrativeFunction: "Climax",
      confidence: 0.92,
      isHighlight: true
    },
    {
      id: "node-4",
      startSec: Math.min(120, duration),
      endSec: duration,
      title: "Call to Action / Outro",
      nodeTypes: ["edit_intent", "audio_change"],
      shotDescription: "Host points to the screen, text overlay 'Subscribe'.",
      visualElements: ["Subscribe button graphic", "Host smiling"],
      audioElements: ["Outro music starts", "Host: 'Like and subscribe for more'"],
      editIntent: "Convert viewers to subscribers and drive engagement.",
      emotionLabel: "Friendly",
      emotionIntensity: 6,
      narrativeFunction: "Ending",
      confidence: 0.90,
      isHighlight: false
    }
  ];
};

export const generateMockReport = (): AnalysisReport => {
  return {
    summary: "This video utilizes a textbook high-retention structure, starting with a strong hook and delivering a payoff exactly at the 60% mark. Emotion builds steadily towards the climax.",
    structure: {
      hook: "0-15s: High energy intro with mystery box.",
      development: "15-45s: Context building using B-roll and graphics.",
      turn: "45-50s: Suspense building sequence before box opens.",
      climax: "50-120s: The reveal and reaction.",
      ending: "120s+: Standard CTA and wrap-up."
    },
    pacing: "Fast-paced intro (avg shot length 1.2s), slowing down during development (avg shot 4s), and accelerating again during the climax.",
    editingStyle: "Dynamic vlog style with frequent punch-ins and sound effect stingers for emphasis.",
    composition: "Primarily medium close-ups optimized for mobile viewing, with text placed in the safe zones.",
    takeaways: [
      "Use physical props to create curiosity gaps in the hook.",
      "Don't let the development phase drag; punctuate with graphics.",
      "Match audio riser intensity with cut frequency."
    ]
  };
};
