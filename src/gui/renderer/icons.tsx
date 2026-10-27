// Small stroke icons (currentColor), sized by CSS.
const P = (d: string) =>
  function Icon() {
    return (
      <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
      </svg>
    );
  };

export const IconPlus = P('M8 3v10M3 8h10');
export const IconSearch = P('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5');
export const IconFolder = P('M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z');
export const IconPencil = P('M11 2.5l2.5 2.5L6 12.5H3.5V10z');
export const IconTrash = P('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5');
export const IconChevron = P('M6 4l4 4-4 4');
export const IconCheck = P('M3.5 8.5l3 3 6-7');
export const IconX = P('M4 4l8 8M12 4l-8 8');
export const IconBan = P('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4');
export const IconStop = P('M5 5h6v6H5z');
export const IconSend = P('M8 13V3M3.5 7.5L8 3l4.5 4.5');
export const IconWarn = P('M8 2.5l6 10.5H2zM8 7v2.5M8 11.5v.01');
export const IconInfo = P('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 7.5V11M8 5v.01');
export const IconAsk = P('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3M8 11.2v.01');
