'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Activity, Boxes, Headset, LayoutDashboard, LifeBuoy, ListTodo, LogOut, Mail, Menu, Mic, Package, Phone, Search, Truck, Users,
} from 'lucide-react';
import BrandMark from './BrandMark.js';
import { signOut } from '@/app/login/actions.js';

const NAV = [
  {
    label: 'Overview',
    items: [{ href: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Sales',
    items: [
      { href: '/products', label: 'Products', icon: Boxes },
      { href: '/orders', label: 'Orders', icon: Package },
      { href: '/customers', label: 'Customers', icon: Users },
    ],
  },
  {
    label: 'Service',
    items: [
      { href: '/cases', label: 'Cases', icon: LifeBuoy },
      { href: '/requests', label: 'Requests', icon: ListTodo },
      { href: '/field-service', label: 'Visits & Shipments', icon: Truck },
      { href: '/activity', label: 'Calls & Emails', icon: Activity },
    ],
  },
  {
    label: 'Voice',
    items: [{ href: '/voice-agent', label: 'AI Voice Agent', icon: Mic }],
  },
];

const isCurrent = (pathname, href) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

export default function ConsoleShell({ email, children }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // The menu closes after moving to another page on a phone.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className={open ? 'shell nav-open' : 'shell'}>
      <aside className="sidebar" aria-label="Console">
        <Link className="brand" href="/">
          <BrandMark />
          <span>
            <span className="brand-name">Tiffany Designs</span>
            <span className="brand-sub">Service console</span>
          </span>
        </Link>

        {NAV.map((group) => (
          <div key={group.label}>
            <div className="nav-label">{group.label}</div>
            <nav className="nav">
              {group.items.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} aria-current={isCurrent(pathname, href) ? 'page' : undefined}>
                  <Icon aria-hidden="true" /> {label}
                </Link>
              ))}
            </nav>
          </div>
        ))}

        <div className="sidebar-foot">
          <div className="user-card">
            <span className="avatar" aria-hidden="true">{email.slice(0, 1)}</span>
            <span className="user-meta">
              <strong>Service team</strong>
              <span title={email}>{email}</span>
            </span>
          </div>
          <form action={signOut}>
            <button className="btn btn-outline btn-block" type="submit">
              <LogOut aria-hidden="true" /> Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />

      <div className="main">
        <div className="utility-bar">
          <span>
            <Phone aria-hidden="true" /> +91-98739-92500
            <span aria-hidden="true">·</span>
            <Mail aria-hidden="true" /> info@tiffanydesigns.in
          </span>
          <span>
            <Headset aria-hidden="true" /> Customer service console · Salesforce data, live
          </span>
        </div>
        <header className="topbar">
          <button className="icon-button menu-button" type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
            <Menu aria-hidden="true" />
          </button>
          <form className="search" action="/search" role="search">
            <label>
              <Search aria-hidden="true" />
              <input type="search" name="q" placeholder="Order, case, customer or product…" aria-label="Search the console" />
            </label>
            <button className="btn" type="submit"><Search aria-hidden="true" /><span>Search</span></button>
          </form>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
