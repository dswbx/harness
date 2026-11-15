/** Briefly rings an element the user jumped to. */
export function flash(el: Element) {
   el.animate(
      [
         { outline: "2px solid var(--ring)", outlineOffset: "4px", borderRadius: "8px" },
         { outline: "2px solid transparent", outlineOffset: "4px", borderRadius: "8px" },
      ],
      { duration: 1600, easing: "ease-in" },
   );
}
