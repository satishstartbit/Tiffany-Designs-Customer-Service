// Shown while a page reads Salesforce through the Node server.
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ height: 28, width: 260, marginBottom: 12 }} />
      <div className="skeleton" style={{ height: 16, width: 420, marginBottom: 28 }} />
      <div className="stats" style={{ marginTop: 0 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}
      </div>
      <div className="skeleton" style={{ height: 320, marginTop: 22 }} />
    </div>
  );
}
