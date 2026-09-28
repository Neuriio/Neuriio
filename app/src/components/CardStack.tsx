// The top-right cards as a layered deck (Account in front, Points behind it). Hovering a card
// springs it up and to the front while the other springs down; each card still morphs into its
// panel on click (Morph reads this context).
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

/** y offset for a card: hovered one lifts, the other sinks, none hovered = at rest */
export function useCardLift(card: string) {
  const stack = useContext(CardStackContext);
  const hovered = stack?.hovered ?? null;
  return {
    lift: hovered === null ? 0 : hovered === card ? -6 : 4,
    front: hovered === card,
    hoverProps: stack
      ? { onPointerEnter: () => stack.setHovered(card), onPointerLeave: () => stack.setHovered(null) }
      : {},
  };
}
