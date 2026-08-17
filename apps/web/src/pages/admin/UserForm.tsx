import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { createUserSchema, updateUserSchema, pickForSchema, type CreateUserDto, type UpdateUserDto } from '@openestate/shared';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/hooks';

interface Role {
  id: string;
  name: string;
  slug: string;
}

export default function UserForm() {
  const { id } = useParams<{ id: string }>();
  const isEdit = id && id !== 'new';
  const navigate = useNavigate();
  const [error, setError] = useState('');

  // GET /roles returns a plain array, not {data, meta} — see Roles.tsx's
  // own fix for this same shape mismatch.
  const { data: roles } = useQuery<Role[]>({
    queryKey: ['roles-all'],
    queryFn: () => api('/roles'),
  });

  const { data: existingUser } = useQuery({
    queryKey: ['user', id],
    queryFn: () => api<Record<string, unknown>>(`/users/${id}`),
    enabled: !!isEdit,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserDto>({
    // Real bug, caught by a Playwright run of this exact flow, not by
    // review: this resolver was ALWAYS createUserSchema, edit mode
    // included — createUserSchema requires `password`, which edit mode
    // never renders/registers at all, so react-hook-form's client-side
    // validation failed silently on every single edit attempt and
    // handleSubmit(onSubmit) never even ran. This is a layer earlier
    // than the email-leak 400 the update endpoint itself would 400 on —
    // the form couldn't reach the network at all. Picking the resolver by
    // isEdit fixes the actual observed symptom ("nothing happens on
    // Update User"); pickForSchema below still strips email defensively.
    resolver: (isEdit
      ? zodResolver(updateUserSchema)
      : zodResolver(createUserSchema)) as Resolver<CreateUserDto>,
  });

  useEffect(() => {
    // Real bug, caught by the same Playwright run: gating this only on
    // existingUser races GET /roles — a native <select>'s value assignment
    // silently no-ops if no matching <option> exists yet, and won't
    // retroactively apply once the options DO render. Gating on both
    // queries means reset() only runs once the role dropdown actually has
    // something for roleId to match against.
    if (existingUser && roles) {
      // Real bug, caught by a Playwright run of this exact flow: reset()
      // seeds react-hook-form's internal values for EVERY key passed to
      // it, regardless of whether that field is currently rendered as an
      // input — disabling the email <input> via register()'s `disabled`
      // option does NOT retroactively strip a value reset() already put
      // there. zodResolver(updateUserSchema) then validated the FULL
      // reset payload (email + password included) against a .strict()
      // schema that declares neither, and rejected every single edit
      // submission with "Unrecognized key(s): 'email', 'password'" before
      // onSubmit ever ran. email/password simply don't belong in this
      // reset call at all — updateUserSchema can't change either one
      // (email has no update path; password goes through the separate
      // force-reset flow below), so only the fields that ARE part of an
      // update belong here.
      reset({
        name: existingUser.name as string,
        phone: (existingUser.phone as string) ?? undefined,
        roleId: (existingUser.role as Role)?.id,
      });
    }
  }, [existingUser, roles, reset]);

  const createMutation = useApiMutation<unknown, CreateUserDto>(
    'POST',
    '/users',
    [['users']],
  );

  const updateMutation = useApiMutation<unknown, UpdateUserDto>(
    'PATCH',
    `/users/${id}`,
    [['users'], ['user', id!]],
  );

  const forceResetMutation = useApiMutation<unknown, void>('POST', `/users/${id}/force-password-reset`);
  const [resetSent, setResetSent] = useState(false);

  const onSubmit = async (data: CreateUserDto) => {
    setError('');
    try {
      if (isEdit) {
        await updateMutation.mutateAsync(pickForSchema(updateUserSchema, data));
      } else {
        await createMutation.mutateAsync(data);
      }
      navigate('/admin/users');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-semibold text-slate-900">
        {isEdit ? 'Edit User' : 'Add User'}
      </h1>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700">Name</label>
          <input
            type="text"
            {...register('name')}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Email</label>
          {isEdit ? (
            // updateUserSchema has no `email` field — it can't be changed
            // via this endpoint. Plain text, not a registered input: a
            // registered-but-disabled input still needed a value from
            // somewhere (reset() or otherwise), and any value present in
            // react-hook-form's internal state gets validated regardless
            // of whether the input rendering it is disabled — that's what
            // broke every edit submission (see the reset() comment above).
            // Not registering it at all is the only way it can never
            // reach the resolver or the submitted payload.
            <p className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
              {existingUser?.email as string}
            </p>
          ) : (
            <input
              type="email"
              {...register('email')}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )}
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
        </div>

        {!isEdit && (
          <div>
            <label className="block text-sm font-medium text-slate-700">Password</label>
            <input
              type="password"
              {...register('password')}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {errors.password && (
              <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">User will be forced to change on first login</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700">Phone</label>
          <input
            type="text"
            {...register('phone')}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Role</label>
          <select
            {...register('roleId')}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Select a role</option>
            {roles?.map((r: Role) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {errors.roleId && <p className="mt-1 text-xs text-red-600">{errors.roleId.message}</p>}
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : isEdit ? 'Update User' : 'Create User'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/admin/users')}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </form>

      {isEdit && (
        <div className="mt-8 rounded-md border border-slate-200 p-4">
          <h2 className="text-sm font-medium text-slate-900">Password</h2>
          <p className="mt-1 text-xs text-slate-500">
            Sends this user a reset link. Their current password stays valid until they use it —
            you never see or set their password directly.
          </p>
          {resetSent && (
            <p className="mt-2 text-xs text-green-700">Reset link sent.</p>
          )}
          <button
            type="button"
            onClick={() => {
              setResetSent(false);
              forceResetMutation.mutate(undefined, { onSuccess: () => setResetSent(true) });
            }}
            disabled={forceResetMutation.isPending}
            className="mt-3 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {forceResetMutation.isPending ? 'Sending…' : 'Force password reset'}
          </button>
        </div>
      )}
    </div>
  );
}
