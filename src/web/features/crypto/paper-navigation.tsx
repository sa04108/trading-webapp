import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export function PaperNavigation({ mode }: { mode: "stock" | "crypto" }) {
  return (
    <nav aria-label="모의투자 구분" className="flex gap-2">
      <Button size="sm" variant={mode === "stock" ? "default" : "outline"} asChild>
        <Link to="/trading" aria-current={mode === "stock" ? "page" : undefined}>
          주식 모의투자
        </Link>
      </Button>
      <Button size="sm" variant={mode === "crypto" ? "default" : "outline"} asChild>
        <Link to="/trading/crypto" aria-current={mode === "crypto" ? "page" : undefined}>
          코인 모의투자
        </Link>
      </Button>
    </nav>
  );
}
