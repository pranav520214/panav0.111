import React from "react";

type P = { size?: number; className?: string };
const S = ({ size = 15, className, children, viewBox = "0 0 24 24", fill = "none" }: P & { children: React.ReactNode; viewBox?: string; fill?: string }) => (
  <svg width={size} height={size} viewBox={viewBox} fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {children}
  </svg>
);

export const IconPlay = (p: P) => <S {...p} fill="currentColor"><path d="M7 4.5v15l13-7.5z" stroke="none" /></S>;
export const IconPause = (p: P) => <S {...p} fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1" stroke="none" /></S>;
export const IconStop = (p: P) => <S {...p} fill="currentColor"><rect x="5.5" y="5.5" width="13" height="13" rx="2" stroke="none" /></S>;
export const IconRecord = (p: P) => <S {...p} fill="currentColor"><circle cx="12" cy="12" r="7" stroke="none" /></S>;
export const IconLoop = (p: P) => <S {...p}><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></S>;
export const IconUndo = (p: P) => <S {...p}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></S>;
export const IconRedo = (p: P) => <S {...p}><path d="M21 7v6h-6" /><path d="M3 17a9 9 0 0 1 15-6.7L21 13" /></S>;
export const IconSave = (p: P) => <S {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></S>;
export const IconDownload = (p: P) => <S {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></S>;
export const IconPlus = (p: P) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const IconMinus = (p: P) => <S {...p}><path d="M5 12h14" /></S>;
export const IconSparkles = (p: P) => <S {...p}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /><path d="M5 16l.7 1.6L7.4 18l-1.7.7L5 20.3 4.3 18.7 2.6 18l1.7-.4z" /></S>;
export const IconX = (p: P) => <S {...p}><path d="M18 6L6 18M6 6l12 12" /></S>;
export const IconChevronDown = (p: P) => <S {...p}><path d="M6 9l6 6 6-6" /></S>;
export const IconMixer = (p: P) => <S {...p}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></S>;
export const IconDice = (p: P) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" /><circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" /></S>;
export const IconEraser = (p: P) => <S {...p}><path d="M20 20H8.5l-5-5a2 2 0 0 1 0-2.8l8.6-8.6a2 2 0 0 1 2.8 0l5.6 5.6a2 2 0 0 1 0 2.8L13 19.5" /><path d="M6.5 11.5l6 6" /></S>;
export const IconPiano = (p: P) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v10M12 4v10M16 4v10" /></S>;
export const IconWave = (p: P) => <S {...p}><path d="M2 12h2l2-5 3 10 3-14 3 12 2-6 2 3h3" /></S>;
export const IconDrum = (p: P) => <S {...p}><ellipse cx="12" cy="7" rx="8" ry="3.4" /><path d="M4 7v9c0 1.9 3.6 3.4 8 3.4s8-1.5 8-3.4V7" /><path d="M4.5 9.5L2 12M19.5 9.5L22 12" /></S>;
export const IconZap = (p: P) => <S {...p} fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6z" stroke="none" /></S>;
export const IconSend = (p: P) => <S {...p}><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></S>;
export const IconCheck = (p: P) => <S {...p}><path d="M20 6L9 17l-5-5" /></S>;
export const IconTrash = (p: P) => <S {...p}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></S>;
export const IconBook = (p: P) => <S {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></S>;
export const IconArrowRight = (p: P) => <S {...p}><path d="M5 12h14M12 5l7 7-7 7" /></S>;

export const BrandMark = ({ size = 26 }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <rect width="32" height="32" rx="8" fill="#1d2330" stroke="#39415a" />
    <path d="M5 16h3l2-7 3 14 3-10 2 5 2-2h7" fill="none" stroke="#00f5ff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
