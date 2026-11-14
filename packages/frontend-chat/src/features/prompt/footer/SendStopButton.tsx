import { Button, Tooltip } from "@harness/ui";
import { ArrowUp, Square } from "lucide-react";

/** Stop while the Agent works, else Send. */
export function SendStopButton({
   running,
   disabled,
   onSend,
   onStop,
}: {
   running: boolean;
   disabled: boolean;
   onSend: () => void;
   onStop: () => void;
}) {
   return running ? (
      <Tooltip content="Stop Agent">
         <Button
            size="icon"
            className="size-6.5 rounded-full [&_svg]:size-3.5"
            onClick={onStop}
            aria-label="Stop Agent"
         >
            <Square className="fill-current" />
         </Button>
      </Tooltip>
   ) : (
      <Button
         size="icon"
         className="size-6.5 rounded-full"
         disabled={disabled}
         onClick={onSend}
         aria-label="Send"
      >
         <ArrowUp />
      </Button>
   );
}
