export interface Option {
  text: string;
  imageUrl?: string;
}

export interface Question {
  id: number;
  text: string;
  imageUrl?: string;
  options: (string | Option)[];
  correctAnswer: number; // 0=A, 1=B, 2=C, 3=D
}

export const QUIZ_QUESTIONS: Question[] = [
  {
    id: 1,
    text: "What is the capital of France?",
    options: ["London", "Paris", "Berlin", "Madrid"],
    correctAnswer: 1,
  },
  {
    id: 2,
    text: "Which planet is known as the Red Planet?",
    options: ["Venus", "Mars", "Jupiter", "Saturn"],
    correctAnswer: 1,
  },
  {
    id: 3,
    text: "Identify this famous landmark:",
    imageUrl: "https://picsum.photos/seed/eiffel/800/450",
    options: ["Big Ben", "Colosseum", "Eiffel Tower", "Leaning Tower"],
    correctAnswer: 2,
  },
  {
    id: 4,
    text: "What is 5 + 7?",
    options: ["10", "11", "12", "13"],
    correctAnswer: 2,
  },
  {
    id: 5,
    text: "Who painted the Mona Lisa?",
    options: ["Van Gogh", "Picasso", "Da Vinci", "Rembrandt"],
    correctAnswer: 2,
  },
  {
    id: 6,
    text: "What is the largest ocean on Earth?",
    options: ["Atlantic", "Indian", "Arctic", "Pacific"],
    correctAnswer: 3,
  },
  {
    id: 7,
    text: "Which animal is this?",
    imageUrl: "https://picsum.photos/seed/lion/800/450",
    options: ["Tiger", "Leopard", "Lion", "Cheetah"],
    correctAnswer: 2,
  },
  {
    id: 8,
    text: "What is the chemical symbol for Gold?",
    options: ["Ag", "Au", "Fe", "Hg"],
    correctAnswer: 1,
  },
  {
    id: 9,
    text: "Which country's flag is this?",
    imageUrl: "https://picsum.photos/seed/japan/800/450",
    options: ["China", "South Korea", "Japan", "Vietnam"],
    correctAnswer: 2,
  },
  {
    id: 10,
    text: "What is the fastest land animal?",
    options: ["Lion", "Cheetah", "Horse", "Greyhound"],
    correctAnswer: 1,
  }
];
