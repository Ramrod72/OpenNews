"use client";

import { useState } from "react";
import type { ExternalAssessment, Source } from "@prisma/client";
import { Save, Plus, Trash2, Pencil, X } from "lucide-react";
import { CSRF_HEADER } from "@/lib/auth/csrf";
import {
  ASSESSMENT_TYPE_LABELS,
  ASSESSMENT_TYPE_VALUES,
  SOURCE_TYPE_LABELS,
  SOURCE_TYPE_VALUES,
} from "@/lib/validation/sourceProfile";

type SourceWithAssessments = Source & { externalAssessments: ExternalAssessment[] };

interface ProfileFormState {
  description: string;
  sourceType: string;
  country: string;
  ownership: string;
  foundedYear: string;
  homepageUrl: string;
  logoUrl: string;
}

function toProfileForm(source: Source): ProfileFormState {
  return {
    description: source.description ?? "",
    sourceType: source.sourceType ?? "",
    country: source.country ?? "",
    ownership: source.ownership ?? "",
    foundedYear: source.foundedYear ? String(source.foundedYear) : "",
    homepageUrl: source.homepageUrl ?? "",
    logoUrl: source.logoUrl ?? "",
  };
}

interface AssessmentFormState {
  provider: string;
  assessmentType: string;
  ratingValue: string;
  ratingScale: string;
  referenceUrl: string;
  assessedAt: string;
  notes: string;
}

const EMPTY_ASSESSMENT_FORM: AssessmentFormState = {
  provider: "",
  assessmentType: ASSESSMENT_TYPE_VALUES[0],
  ratingValue: "",
  ratingScale: "",
  referenceUrl: "",
  assessedAt: "",
  notes: "",
};

function toAssessmentForm(a: ExternalAssessment): AssessmentFormState {
  return {
    provider: a.provider,
    assessmentType: a.assessmentType,
    ratingValue: a.ratingValue,
    ratingScale: a.ratingScale ?? "",
    referenceUrl: a.referenceUrl ?? "",
    assessedAt: a.assessedAt ? a.assessedAt.toISOString().slice(0, 10) : "",
    notes: a.notes ?? "",
  };
}

export function SourceProfileManager({ source }: { source: SourceWithAssessments }) {
  const [profileForm, setProfileForm] = useState(toProfileForm(source));
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const [assessments, setAssessments] = useState(source.externalAssessments);
  const [newAssessment, setNewAssessment] = useState(EMPTY_ASSESSMENT_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<AssessmentFormState>(EMPTY_ASSESSMENT_FORM);
  const [editError, setEditError] = useState<string | null>(null);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    setProfileStatus(null);
    try {
      const res = await fetch(`/api/admin/sources/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify({
          ...profileForm,
          foundedYear: profileForm.foundedYear ? Number(profileForm.foundedYear) : null,
        }),
      });
      setProfileStatus(res.ok ? "Saved." : "Could not save — check the fields above.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function addAssessment(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`/api/admin/sources/${source.id}/assessments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
        body: JSON.stringify(newAssessment),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(typeof data.error === "string" ? data.error : "Could not add assessment");
        return;
      }
      setAssessments((prev) => [...prev, data.assessment]);
      setNewAssessment(EMPTY_ASSESSMENT_FORM);
    } finally {
      setAdding(false);
    }
  }

  async function saveEdit(id: string) {
    setEditError(null);
    const res = await fetch(`/api/admin/sources/${source.id}/assessments/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [CSRF_HEADER]: "1" },
      body: JSON.stringify(editForm),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditError(typeof data.error === "string" ? data.error : "Could not save changes");
      return;
    }
    setAssessments((prev) => prev.map((a) => (a.id === id ? data.assessment : a)));
    setEditingId(null);
  }

  async function deleteAssessment(id: string) {
    if (!confirm("Delete this assessment?")) return;
    const res = await fetch(`/api/admin/sources/${source.id}/assessments/${id}`, {
      method: "DELETE",
      headers: { [CSRF_HEADER]: "1" },
    });
    if (res.ok) setAssessments((prev) => prev.filter((a) => a.id !== id));
  }

  return (
    <div className="flex flex-col gap-8">
      <form
        onSubmit={saveProfile}
        className="grid grid-cols-1 gap-3 rounded-xl border border-border p-4 sm:grid-cols-2"
      >
        <h2 className="col-span-full font-bold">Profile metadata</h2>
        <Field label="Source type">
          <select
            value={profileForm.sourceType}
            onChange={(e) => setProfileForm({ ...profileForm, sourceType: e.target.value })}
            className="input"
          >
            <option value="">Not set</option>
            {SOURCE_TYPE_VALUES.map((v) => (
              <option key={v} value={v}>
                {SOURCE_TYPE_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Country">
          <input
            value={profileForm.country}
            onChange={(e) => setProfileForm({ ...profileForm, country: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Ownership / parent organization">
          <input
            value={profileForm.ownership}
            onChange={(e) => setProfileForm({ ...profileForm, ownership: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Founded year">
          <input
            type="number"
            value={profileForm.foundedYear}
            onChange={(e) => setProfileForm({ ...profileForm, foundedYear: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Homepage URL">
          <input
            type="url"
            value={profileForm.homepageUrl}
            onChange={(e) => setProfileForm({ ...profileForm, homepageUrl: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Logo URL">
          <input
            type="url"
            value={profileForm.logoUrl}
            onChange={(e) => setProfileForm({ ...profileForm, logoUrl: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={profileForm.description}
            onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })}
            rows={3}
            className="input"
          />
        </Field>
        <div className="col-span-full flex items-center gap-3">
          <button
            type="submit"
            disabled={savingProfile}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-60"
          >
            <Save size={15} /> {savingProfile ? "Saving…" : "Save profile"}
          </button>
          {profileStatus && <span className="text-sm text-foreground-muted">{profileStatus}</span>}
        </div>
      </form>

      <div className="rounded-xl border border-border p-4">
        <h2 className="mb-1 font-bold">External assessments</h2>
        <p className="mb-4 text-sm text-foreground-muted">
          Each assessment must name the organization that made it. Veriqen never invents or averages
          ratings — enter exactly what the named provider published.
        </p>

        <ul className="mb-4 flex flex-col gap-3">
          {assessments.map((a) =>
            editingId === a.id ? (
              <li key={a.id} className="rounded-lg border border-accent p-3">
                <AssessmentFields form={editForm} setForm={setEditForm} />
                {editError && <p className="mt-2 text-sm text-breaking">{editError}</p>}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => saveEdit(a.id)}
                    className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold"
                  >
                    <X size={12} /> Cancel
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={a.id}
                className="flex items-start justify-between rounded-lg border border-border p-3"
              >
                <div>
                  <p className="text-xs font-semibold tracking-wide text-foreground-muted uppercase">
                    {ASSESSMENT_TYPE_LABELS[
                      a.assessmentType as keyof typeof ASSESSMENT_TYPE_LABELS
                    ] ?? a.assessmentType}
                  </p>
                  <p className="font-semibold">
                    {a.provider}: {a.ratingValue}
                  </p>
                  {a.ratingScale && (
                    <p className="text-xs text-foreground-muted">Scale: {a.ratingScale}</p>
                  )}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    title="Edit"
                    onClick={() => {
                      setEditingId(a.id);
                      setEditForm(toAssessmentForm(a));
                      setEditError(null);
                    }}
                    className="rounded p-1.5 hover:bg-surface-muted"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => deleteAssessment(a.id)}
                    className="rounded p-1.5 text-breaking hover:bg-surface-muted"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ),
          )}
          {assessments.length === 0 && (
            <li className="text-sm text-foreground-muted italic">No assessments yet.</li>
          )}
        </ul>

        <form
          onSubmit={addAssessment}
          className="rounded-lg border border-dashed border-border p-3"
        >
          <p className="mb-2 text-sm font-semibold">Add an assessment</p>
          <AssessmentFields form={newAssessment} setForm={setNewAssessment} />
          {addError && <p className="mt-2 text-sm text-breaking">{addError}</p>}
          <button
            type="submit"
            disabled={adding}
            className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground disabled:opacity-60"
          >
            <Plus size={14} /> {adding ? "Adding…" : "Add assessment"}
          </button>
        </form>
      </div>
    </div>
  );
}

function AssessmentFields({
  form,
  setForm,
}: {
  form: AssessmentFormState;
  setForm: (f: AssessmentFormState) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Provider">
        <input
          value={form.provider}
          onChange={(e) => setForm({ ...form, provider: e.target.value })}
          placeholder="e.g. Example Rating Institute"
          className="input"
        />
      </Field>
      <Field label="Assessment type">
        <select
          value={form.assessmentType}
          onChange={(e) => setForm({ ...form, assessmentType: e.target.value })}
          className="input"
        >
          {ASSESSMENT_TYPE_VALUES.map((v) => (
            <option key={v} value={v}>
              {ASSESSMENT_TYPE_LABELS[v]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Rating value">
        <input
          value={form.ratingValue}
          onChange={(e) => setForm({ ...form, ratingValue: e.target.value })}
          placeholder="e.g. Left-Center"
          className="input"
        />
      </Field>
      <Field label="Rating scale (optional)">
        <input
          value={form.ratingScale}
          onChange={(e) => setForm({ ...form, ratingScale: e.target.value })}
          placeholder="e.g. Left / Left-Center / Center / Right-Center / Right"
          className="input"
        />
      </Field>
      <Field label="Reference URL (optional)">
        <input
          type="url"
          value={form.referenceUrl}
          onChange={(e) => setForm({ ...form, referenceUrl: e.target.value })}
          className="input"
        />
      </Field>
      <Field label="Date assessed (optional)">
        <input
          type="date"
          value={form.assessedAt}
          onChange={(e) => setForm({ ...form, assessedAt: e.target.value })}
          className="input"
        />
      </Field>
      <Field label="Notes (optional)">
        <input
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          className="input"
        />
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
    </label>
  );
}
