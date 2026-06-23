"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Truck, Package, CheckCircle, Clock, Search, X,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
} from "lucide-react";
import { KPICard } from "@/components/ui/KPICard";
import { UpgradeGate } from "@/components/ui/UpgradeGate";
import { shipmentsApi } from "@/lib/api";
import { usePermissions } from "@/contexts/PermissionsContext";
import { formatCurrency, formatDateTime } from "@/lib/utils";

const PAGE_SIZE = 50;

const STATUS_LABELS: Record<string, string> = {
  pending: "Aguardando etiqueta",
  handling: "Preparando envio",
  ready_to_ship: "Pronto para despachar",
  shipped: "Em trânsito",
  not_delivered: "Não entregue",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

const STATUS_LIST = Object.keys(STATUS_LABELS);

const STATUS_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  pending:        { text: "#eab308", bg: "rgba(234,179,8,0.1)",  border: "rgba(234,179,8,0.3)" },
  handling:       { text: "#eab308", bg: "rgba(234,179,8,0.1)",  border: "rgba(234,179,8,0.3)" },
  ready_to_ship:  { text: "#3b82f6", bg: "rgba(59,130,246,0.1)", border: "rgba(59,130,246,0.3)" },
  shipped:        { text: "#3b82f6", bg: "rgba(59,130,246,0.1)", border: "rgba(59,130,246,0.3)" },
  delivered:      { text: "#22c55e", bg: "rgba(34,197,94,0.1)",  border: "rgba(34,197,94,0.3)" },
  not_delivered:  { text: "#ef4444", bg: "rgba(239,68,68,0.1)",  border: "rgba(239,68,68,0.3)" },
  cancelled:      { text: "#ef4444", bg: "rgba(239,68,68,0.1)",  border: "rgba(239,68,68,0.3)" },
};

function ShipmentStatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { text: "#8888a8", bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.1)" };
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide whitespace-nowrap"
      style={{ color: c.text, background: c.bg, border: `1px solid ${c.border}` }}
    >
      {label}
    </span>
  );
}

type SortField = "dateCreated" | "status" | "cost";
type SortDir = "asc" | "desc";

export default function ShipmentsPage() {
  const [shipments, setShipments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [costMin, setCostMin] = useState("");
  const [costMax, setCostMax] = useState("");
  const [sortField, setSortField] = useState<SortField>("dateCreated");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [showCostFilter, setShowCostFilter] = useState(false);

  const { can, isFuncionario } = usePermissions();

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setCurrentPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = {
      page: String(currentPage),
      limit: String(PAGE_SIZE),
      sortField,
      sortDir,
    };
    if (search) params.search = search;
    if (statusFilter) params.status = statusFilter;
    if (costMin) params.costMin = costMin;
    if (costMax) params.costMax = costMax;

    shipmentsApi.list(params)
      .then(({ data }) => {
        setShipments(data.shipments ?? []);
        setTotal(data.total ?? 0);
        setTotalPages(data.totalPages ?? 1);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [currentPage, search, statusFilter, costMin, costMax, sortField, sortDir]);

  useEffect(() => { load(); }, [load]);

  if (isFuncionario && !can("view_shipments")) {
    return <UpgradeGate feature="Ver Envios" requiredPlan="prata" />;
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const activeFiltersCount = (statusFilter ? 1 : 0) + (search ? 1 : 0) + (costMin || costMax ? 1 : 0);

  const clearFilters = () => {
    setSearchInput(""); setSearch(""); setStatusFilter("");
    setCostMin(""); setCostMax(""); setCurrentPage(1);
  };

  // KPIs somam só a página atual? Não — fazemos contagem geral via outra chamada seria ideal,
  // mas para simplicidade mantemos baseado nos dados carregados na página atual.
  const counts = {
    total,
    inTransit: shipments.filter((s) => s.status === "shipped" || s.status === "ready_to_ship").length,
    delivered: shipments.filter((s) => s.status === "delivered").length,
    pending: shipments.filter((s) => s.status === "pending" || s.status === "handling").length,
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard label="Total de Envios" value={loading ? "—" : counts.total} icon={Package} loading={loading} />
        <KPICard label="Em trânsito (pág.)" value={counts.inTransit} icon={Truck} color="#3b82f6" loading={loading} />
        <KPICard label="Entregues (pág.)" value={counts.delivered} icon={CheckCircle} color="#22c55e" loading={loading} />
        <KPICard label="Pendentes (pág.)" value={counts.pending} icon={Clock} color="#eab308" loading={loading} />
      </div>

      {/* Toolbar */}
      <div className="flex gap-2 flex-wrap">
        <div className="flex-1 min-w-[200px] relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por ID do envio..."
            className="w-full bg-bg-3 border border-border rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-dim outline-none focus:border-brand/50"
          />
          {searchInput && (
            <button onClick={() => setSearchInput("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-dim hover:text-white">
              <X size={13} />
            </button>
          )}
        </div>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
          className="bg-bg-3 border border-border rounded-lg px-3 py-2 text-sm text-muted outline-none cursor-pointer"
        >
          <option value="">Todos os status</option>
          {STATUS_LIST.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>

        <div className="relative">
          <button
            onClick={() => setShowCostFilter((p) => !p)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition-all ${
              costMin || costMax
                ? "bg-brand/15 border-brand/50 text-brand"
                : "bg-bg-3 border-border text-muted hover:text-white"
            }`}
          >
            Custo {costMin || costMax ? `(${costMin || "0"}–${costMax || "∞"})` : ""}
          </button>
          {showCostFilter && (
            <div className="absolute top-10 left-0 z-50 bg-bg-4 border border-border rounded-xl shadow-xl p-3 min-w-[200px] flex flex-col gap-2">
              <p className="text-[10px] text-dim uppercase tracking-widest">Filtrar por custo (R$)</p>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="Mín."
                  value={costMin}
                  onChange={(e) => { setCostMin(e.target.value); setCurrentPage(1); }}
                  className="w-full bg-bg-5 border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand/50"
                />
                <input
                  type="number"
                  placeholder="Máx."
                  value={costMax}
                  onChange={(e) => { setCostMax(e.target.value); setCurrentPage(1); }}
                  className="w-full bg-bg-5 border border-border rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-brand/50"
                />
              </div>
              {(costMin || costMax) && (
                <button onClick={() => { setCostMin(""); setCostMax(""); }} className="text-[10px] text-red-400 hover:text-red-300 text-left">
                  Limpar filtro de custo
                </button>
              )}
            </div>
          )}
        </div>

        {activeFiltersCount > 0 && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-xs font-semibold"
          >
            <X size={12} /> Limpar filtros
          </button>
        )}
      </div>

      {/* Contagem + paginação topo */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-dim">
          {loading ? "Carregando..." : `${total} envio${total !== 1 ? "s" : ""} — página ${currentPage} de ${totalPages}`}
        </p>
        {totalPages > 1 && (
          <PaginationControls currentPage={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
        )}
      </div>

      <div className="bg-bg-3 border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-bg-4">
                <th className="px-4 py-3 text-[10px] font-semibold text-dim uppercase tracking-widest">ID do Envio</th>
                <th className="px-4 py-3 text-[10px] font-semibold text-dim uppercase tracking-widest">Conta ML</th>
                <th className="px-4 py-3 text-[10px] font-semibold text-dim uppercase tracking-widest">
                  <button onClick={() => handleSort("status")} className="hover:text-white transition-colors">Status</button>
                </th>
                <th className="px-4 py-3 text-[10px] font-semibold text-dim uppercase tracking-widest">Rastreio</th>
                <th className="px-4 py-3 text-[10px] font-semibold text-dim uppercase tracking-widest">
                  <button onClick={() => handleSort("cost")} className="hover:text-white transition-colors">Custo</button>
                </th>
                <th className="px-4 py-3 text-[10px] font-semibold text-dim uppercase tracking-widest">
                  <button onClick={() => handleSort("dateCreated")} className="hover:text-white transition-colors">Data</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-border/20">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>
                  ))}
                </tr>
              )) : shipments.map((s) => {
                const accountLabel = s.token?.apelido || s.token?.mlNickname || "—";
                return (
                  <tr key={s.id} className="border-b border-border/20 hover:bg-bg-4 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-muted">{s.mlShipmentId}</td>
                    <td className="px-4 py-3 text-sm text-muted">{accountLabel}</td>
                    <td className="px-4 py-3"><ShipmentStatusBadge status={s.status} /></td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{s.trackingNumber ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-sm text-white">{s.cost != null ? formatCurrency(s.cost) : "—"}</td>
                    <td className="px-4 py-3 text-xs text-dim">{formatDateTime(s.dateCreated)}</td>
                  </tr>
                );
              })}
              {!loading && shipments.length === 0 && (
                <tr><td colSpan={6} className="py-16 text-center text-muted text-sm">Nenhum envio encontrado</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-dim">
            Mostrando {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, total)} de {total} envios
          </p>
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            onChange={(p) => { setCurrentPage(p); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          />
        </div>
      )}
    </div>
  );
}

function PaginationControls({ currentPage, totalPages, onChange }: {
  currentPage: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const pages = () => {
    const delta = 2;
    const range: (number | "...")[] = [];
    for (let i = Math.max(2, currentPage - delta); i <= Math.min(totalPages - 1, currentPage + delta); i++) {
      range.push(i);
    }
    if (currentPage - delta > 2) range.unshift("...");
    if (currentPage + delta < totalPages - 1) range.push("...");
    range.unshift(1);
    if (totalPages > 1) range.push(totalPages);
    return range;
  };

  const btn = "w-8 h-8 flex items-center justify-center rounded-lg text-xs font-semibold transition-colors";

  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onChange(1)} disabled={currentPage === 1}
        className={`${btn} border border-border text-dim hover:text-white disabled:opacity-30 disabled:cursor-not-allowed`}>
        <ChevronsLeft size={13} />
      </button>
      <button onClick={() => onChange(currentPage - 1)} disabled={currentPage === 1}
        className={`${btn} border border-border text-dim hover:text-white disabled:opacity-30 disabled:cursor-not-allowed`}>
        <ChevronLeft size={13} />
      </button>
      {pages().map((p, i) => p === "..." ? (
        <span key={`dots-${i}`} className="w-8 h-8 flex items-center justify-center text-dim text-xs">...</span>
      ) : (
        <button key={p} onClick={() => onChange(p as number)}
          className={`${btn} border ${currentPage === p ? "border-brand bg-brand/15 text-brand" : "border-border text-muted hover:text-white hover:border-border-light"}`}>
          {p}
        </button>
      ))}
      <button onClick={() => onChange(currentPage + 1)} disabled={currentPage === totalPages}
        className={`${btn} border border-border text-dim hover:text-white disabled:opacity-30 disabled:cursor-not-allowed`}>
        <ChevronRight size={13} />
      </button>
      <button onClick={() => onChange(totalPages)} disabled={currentPage === totalPages}
        className={`${btn} border border-border text-dim hover:text-white disabled:opacity-30 disabled:cursor-not-allowed`}>
        <ChevronsRight size={13} />
      </button>
    </div>
  );
}