'use client';

import React, { useState, useEffect } from 'react';
import { setModalHandler, ModalType, ModalOption } from '@/lib/modal';

interface ModalState {
  isOpen: boolean;
  message: string;
  type: ModalType;
  options: ModalOption[];
  resolve: (value: string | null) => void;
}

export function GlobalModal() {
  const [modalState, setModalState] = useState<ModalState | null>(null);

  useEffect(() => {
    setModalHandler((message, type, options, resolve) => {
      setModalState({ isOpen: true, message, type, options, resolve });
    });
  }, []);

  if (!modalState?.isOpen) return null;

  const handleClose = (value: string | null) => {
    modalState.resolve(value);
    setModalState((s) => (s ? { ...s, isOpen: false } : null));
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'fadeIn 0.2s ease-out'
      }}
      onClick={() => handleClose(null)}
    >
      <div
        style={{
          backgroundColor: 'var(--surface)',
          padding: '24px',
          borderRadius: '12px',
          maxWidth: '480px',
          width: '90%',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
          animation: 'slideUp 0.2s ease-out'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p style={{ margin: '0 0 24px 0', fontSize: '15px', lineHeight: '1.6', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
          {modalState.message}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', flexWrap: 'wrap' }}>
          {modalState.options.map((opt) => (
            <button
              key={opt.value}
              className={`btn ${opt.primary ? 'btn-primary' : ''}`}
              onClick={() => handleClose(opt.value)}
              style={
                opt.primary 
                  ? { backgroundColor: 'var(--accent)', color: '#000', borderColor: 'var(--accent)' } 
                  : { color: 'var(--text-secondary)' }
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(10px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
