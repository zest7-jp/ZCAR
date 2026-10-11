/**
 * START の行き先の印(★)。車の DEST とスマホの目的地の一覧で使う。
 * filled が false のときは輪郭だけ(☆)。
 */
export function StarMark({ filled }: { filled: boolean }) {
  return (
    <svg
      className={`star-mark${filled ? " is-filled" : ""}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M12 3l2.5 6.1 6.6.5-5 4.3 1.5 6.5-5.6-3.5-5.6 3.5 1.5-6.5-5-4.3 6.6-.5z" />
    </svg>
  );
}
