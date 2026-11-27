import type { OverlayFrame, PanelWidth } from "@harness/api";
import { cn } from "@harness/ui";
import { type ComponentProps, type ReactNode, useEffect } from "react";
import { DockLayout, type DockPanel } from "../dock/DockLayout";
import { sideWidths } from "../dock/geometry";
import type { Layout } from "../dock/model";
import { OVERLAY_ZONES, overlayGeometry, STRIPE_W } from "../dock/overlay";
import { Stripe, type StripeGroup } from "../dock/Stripe";

/** The callbacks the dock's two trees (main and Quick overlay) share. */
export type DockCallbacks = Pick<
   ComponentProps<typeof DockLayout>,
   "drag" | "onResize" | "onMove" | "onHide" | "onExpand" | "onDragStart"
>;

/**
 * The Quick overlay's tree (ADR 0022): before the first message only the prompt box, at the bottom of the
 * transparent window. Then the chat in the host's card, with side panels beside it. The stripes are the side
 * zones only, attached to the chat card's edges. The window grows by the open panels and the stripes
 * (`onPanelWidth`); none before the first message. The card has a fixed width; a side's panels and stripe show
 * once the host window has room for them (and stop before it shrinks), so opening or closing a panel never
 * moves or reflows the chat.
 */
export function OverlayDock({
   draft,
   promptBox,
   chat,
   chatFrame,
   onPanelWidth,
   overlayFrame,
   shown,
   left,
   right,
   panels,
   dock,
   onToggle,
   menu,
   ghost,
}: {
   /** Before the first message. */
   draft: boolean;
   promptBox: ReactNode;
   chat: ReactNode;
   chatFrame?: (chat: ReactNode) => ReactNode;
   onPanelWidth?: (width: PanelWidth) => void;
   overlayFrame?: OverlayFrame;
   shown: Layout;
   left: [StripeGroup, StripeGroup, StripeGroup];
   right: [StripeGroup, StripeGroup, StripeGroup];
   panels: DockPanel[];
   dock: DockCallbacks;
   onToggle: (id: string) => void;
   /** The entries of a stripe icon's context menu. */
   menu?: (id: string) => ReactNode;
   ghost: ReactNode;
}) {
   const sideL: [StripeGroup, StripeGroup] = [left[0], left[1]];
   const sideR: [StripeGroup, StripeGroup] = [right[0], right[1]];
   const stripeL = !draft && sideL.some((g) => g.items.length > 0);
   const stripeR = !draft && sideR.some((g) => g.items.length > 0);
   const sides = sideWidths(shown);
   const wantL = draft ? 0 : sides.left + (stripeL ? STRIPE_W : 0);
   const wantR = draft ? 0 : sides.right + (stripeR ? STRIPE_W : 0);
   useEffect(() => {
      onPanelWidth?.({ left: wantL, right: wantR });
   }, [wantL, wantR, onPanelWidth]);
   const geo = overlayFrame
      ? overlayGeometry(
           shown,
           overlayFrame.room,
           { left: stripeL, right: stripeR },
           overlayFrame.card,
        )
      : null;
   const drawnL = geo ? geo.stripes.left : stripeL;
   const drawnR = geo ? geo.stripes.right : stripeR;

   if (draft) return <div className="relative flex h-full flex-col justify-end">{promptBox}</div>;

   const column = <div className="relative flex min-h-0 flex-1 flex-col">{chat}</div>;
   const tab = (side: "left" | "right", groups: [StripeGroup, StripeGroup]) => (
      <div
         className={cn(
            "mt-3 shrink-0 self-start overflow-hidden border bg-background",
            side === "left" ? "-mr-px rounded-l-lg border-r-0" : "-ml-px rounded-r-lg border-l-0",
         )}
      >
         <Stripe
            side={side}
            groups={groups}
            drag={dock.drag}
            onToggle={onToggle}
            menu={menu}
            onPress={(it, e) => dock.onDragStart(it.id, it.label, e)}
         />
      </div>
   );
   return (
      <div className="relative flex h-full" style={geo ? { paddingLeft: geo.offset } : undefined}>
         <DockLayout
            {...dock}
            layout={geo?.layout ?? shown}
            width={geo?.width}
            chat={
               <div className="flex min-h-0 flex-1">
                  {drawnL && tab("left", sideL)}
                  {chatFrame ? (
                     chatFrame(column)
                  ) : (
                     <div className="flex min-w-0 flex-1 flex-col">{column}</div>
                  )}
                  {drawnR && tab("right", sideR)}
               </div>
            }
            panels={panels}
            leftStripeOverlay={false}
            zones={OVERLAY_ZONES}
            floating
         />
         {ghost}
      </div>
   );
}
