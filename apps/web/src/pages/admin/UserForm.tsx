import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { createUserSchema, type CreateUserDto } from '@openestate/shared';
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

  const { data: roles } = useQuery<{ data: Role[] }>({
    queryKey: ['roles-all'],
    queryFn: () => api('/roles?limit=100'),
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
    resolver: zodResolver(createUserSchema),
  });

  useEffect(() => {
    if (existingUser) {
      reset({
        email: existingUser.email as string,
        name: existingUser.name as string,
        phone: (existingUser.phone as string) ?? undefined,
        roleId: (existingUser.role as Role)?.id,
        password: '',
      });
    }
  }, [existingUser, reset]);

  const createMutation = useApiMutation<unknown, CreateUserDto>(
    'POST',
    '/users',
    [['users']],
  );

  const updateMutation = useApiMutation<unknown, Partial<CreateUserDto>>(
    'PATCH',
    `/users/${id}`,
    [['users'], ['user', id!]],
  );

  const onSubmit = async (data: CreateUserDto) => {
    setError('');
    try {
      if (isEdit) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password: _password, ...updateData } = data;
        await updateMutation.mutateAsync(updateData);
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
          <input
            type="email"
            {...register('email')}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
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
            {roles?.data?.map((r: Role) => (
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
    </div>
  );
}
