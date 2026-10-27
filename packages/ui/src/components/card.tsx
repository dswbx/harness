import * as React from "react";
import { cn } from "../lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col rounded-lg border bg-card text-card-foreground shadow-xs", className)} {...props} />;
}
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-2 px-3 py-2", className)} {...props} />;
}
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("text-sm font-medium leading-none", className)} {...props} />;
}
function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-3 pb-3", className)} {...props} />;
}
export { Card, CardHeader, CardTitle, CardContent };
