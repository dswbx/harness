import { cn } from "../lib/utils";

/** "Agent is working" indicator: four squares that fold around a 2x2 grid (`.working-loader` in styles.css). Fits a 16px box; color is the text color. */
function WorkingLoader({ className }: { className?: string }) {
   return (
      <span className={cn("grid size-2 shrink-0 place-items-center", className)} aria-hidden>
         <span className="working-loader" />
      </span>
   );
}

export { WorkingLoader };
