"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Mixins" },
  { href: "/players", label: "Players" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav>
      {LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
        return (
          <Link key={link.href} href={link.href} className={active ? "on" : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
