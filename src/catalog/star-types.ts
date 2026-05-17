export const STAR_MODEL_TYPES = [
  {
    id: "blue-star",
    label: "Blue star / blue giant",
    description: "Hot O/B class stars with blue-white photospheres.",
    color: [0.62, 0.74, 1.0] as [number, number, number],
  },
  {
    id: "blue-white-star",
    label: "Blue-white / white star",
    description: "A/F class stars with a white core and subtle cool tint.",
    color: [0.9, 0.95, 1.0] as [number, number, number],
  },
  {
    id: "sun-like-star",
    label: "Sun-like yellow star",
    description: "G class main-sequence stars with yellow-white granulation.",
    color: [1.0, 0.9, 0.66] as [number, number, number],
  },
  {
    id: "orange-star",
    label: "Orange star",
    description: "K class stars with warm orange photospheres.",
    color: [1.0, 0.64, 0.32] as [number, number, number],
  },
  {
    id: "red-dwarf",
    label: "Red dwarf",
    description: "Cool compact M class main-sequence stars.",
    color: [1.0, 0.34, 0.22] as [number, number, number],
  },
  {
    id: "red-giant",
    label: "Red giant",
    description: "Expanded K/M giants with large convection cells.",
    color: [1.0, 0.42, 0.18] as [number, number, number],
  },
  {
    id: "red-supergiant",
    label: "Red supergiant",
    description: "Very large cool supergiants such as Betelgeuse and Antares.",
    color: [1.0, 0.26, 0.12] as [number, number, number],
  },
  {
    id: "white-dwarf",
    label: "White dwarf",
    description: "Small dense stellar remnants with smooth white/blue surfaces.",
    color: [0.88, 0.94, 1.0] as [number, number, number],
  },
] as const;

export type StarModelTypeId = typeof STAR_MODEL_TYPES[number]["id"];

export interface StarTypeInput {
  spectralType?: string | null | undefined;
  temperatureK?: number | null | undefined;
  radiusSolar?: number | null | undefined;
  color?: readonly [number, number, number] | null | undefined;
}

function spectralLetter(spectralType: string | null | undefined): string | null {
  return spectralType?.trim().toUpperCase().match(/[OBAFGKM]/)?.[0] ?? null;
}

function spectralLuminosityClass(
  spectralType: string | null | undefined,
): "I" | "II" | "III" | "IV" | "V" | "D" | null {
  const upper = spectralType?.trim().toUpperCase().replace(/\s+/g, "") ?? "";
  if (upper.length === 0) return null;
  if (upper.startsWith("D") || upper.includes("WD")) return "D";
  if (upper.includes("IA") || upper.includes("IB") || upper.includes("IAB")) return "I";
  if (upper.includes("III")) return "III";
  if (upper.includes("II")) return "II";
  if (upper.includes("IV")) return "IV";
  if (upper.includes("V")) return "V";
  return null;
}

export function starModelTypeIndex(typeId: StarModelTypeId): number {
  const index = STAR_MODEL_TYPES.findIndex(type => type.id === typeId);
  return Math.max(0, index);
}

export function classifyStarModelType(input: StarTypeInput): StarModelTypeId {
  const spectralType = input.spectralType ?? null;
  const letter = spectralLetter(spectralType);
  const luminosityClass = spectralLuminosityClass(spectralType);
  const radiusSolar = Number.isFinite(input.radiusSolar) ? Number(input.radiusSolar) : null;
  const temperatureK = Number.isFinite(input.temperatureK) ? Number(input.temperatureK) : null;
  const color = input.color ?? null;
  const redDominant = color ? color[0] > color[2] * 1.35 && color[1] < 0.78 : false;
  const blueDominant = color ? color[2] > color[0] * 1.06 : false;

  if (luminosityClass === "D" || (radiusSolar !== null && radiusSolar < 0.08 && (blueDominant || (temperatureK ?? 0) > 6_500))) {
    return "white-dwarf";
  }

  if (
    luminosityClass === "I" ||
    (radiusSolar !== null && radiusSolar >= 150)
  ) {
    return redDominant || letter === "K" || letter === "M" || (temperatureK !== null && temperatureK < 5_200)
      ? "red-supergiant"
      : "blue-star";
  }

  if (
    luminosityClass === "II" ||
    luminosityClass === "III" ||
    (radiusSolar !== null && radiusSolar >= 8)
  ) {
    return redDominant || letter === "K" || letter === "M" || (temperatureK !== null && temperatureK < 5_200)
      ? "red-giant"
      : "blue-star";
  }

  if (temperatureK !== null) {
    if (temperatureK >= 10_000) return "blue-star";
    if (temperatureK >= 6_500) return "blue-white-star";
    if (temperatureK >= 5_200) return "sun-like-star";
    if (temperatureK >= 3_700) return "orange-star";
    return "red-dwarf";
  }

  switch (letter) {
    case "O":
    case "B": return "blue-star";
    case "A":
    case "F": return "blue-white-star";
    case "G": return "sun-like-star";
    case "K": return "orange-star";
    case "M": return "red-dwarf";
    default:
      if (blueDominant) return "blue-star";
      if (redDominant) return radiusSolar !== null && radiusSolar > 4 ? "red-giant" : "red-dwarf";
      return "sun-like-star";
  }
}
