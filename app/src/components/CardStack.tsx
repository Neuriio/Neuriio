// The top-right cards (Account, Points). On the landing they're a layered deck (Account in front, Points behind it)
// and hovering a card brings it to the front; no hover animation (user, 2026-10-18). Each card morphs into its panel
// on click (Morph reads this context).
import { createContext, useContext, useState, type ReactNode } from "react";

type Stack = { hovered: string | null; setHovered: (card: string | null) => void };

const CardStackContext = createContext<Stack | null>(null);

export function CardStack({ children }: { children: ReactNode }) {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <CardStackContext.Provider value={{ hovered, setHovered }}>
      <div className="top-right card-stack">{children}</div>
    </CardStackContext.Provider>
  );
}

/** Whether a card is hovered (it comes to the front of the deck). */
export function useCardLift(card: string) {
  const stack = useContext(CardStackContext);
  const hovered = stack?.hovered ?? null;
  return {
    front: hovered === card,
    hoverProps: stack
      ? { onPointerEnter: () => stack.setHovered(card), onPointerLeave: () => stack.setHovered(null) }
      : {},
  };
}
