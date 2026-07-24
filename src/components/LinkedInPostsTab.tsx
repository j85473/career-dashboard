import React, { useState, useEffect } from 'react';
import { Send, ThumbsDown, Copy, Loader, ExternalLink } from 'lucide-react';

interface LinkedInOption {
  title: string;
  postText: string;
  url: string;
  createdAt?: string;
}

export function LinkedInPostsTab() {
  const [options, setOptions] = useState<LinkedInOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/linkedin/generate', { signal: controller.signal })
      .then(response => response.json())
      .then(data => {
        if (Array.isArray(data.options) && data.options.length > 0) {
          setOptions(data.options);
        }
      })
      .catch(error => {
        if (!controller.signal.aborted) console.error(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, []);

  const generateOptions = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/linkedin/generate', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start generation');
      
      // Generation started in background, start polling
      pollForDrafts();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    }
  };

  const pollForDrafts = () => {
    const startTime = Date.now();
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/linkedin/generate');
        const data = await res.json();
        
        // If we have options, and they are reasonably fresh (created recently)
        // Actually, just checking if there are ANY options is fine, but to be safe, 
        // if they are generated they will have a recent createdAt in the DB.
        // We can just assume that if the user clicked generate, we wait until new ones appear.
        // Since we fetch the latest 3, let's just check if their createdAt is after our startTime.
        if (data.options && data.options.length > 0) {
          const latestDraftTime = new Date(data.options[0].createdAt).getTime();
          if (latestDraftTime > startTime - 5000) { // allow 5s buffer
            setOptions(data.options);
            setLoading(false);
            clearInterval(interval);
            return;
          }
        }
        
        if (Date.now() - startTime > 120000) { // 2 minute timeout
          clearInterval(interval);
          setLoading(false);
          setError("Generation timed out. Please try again.");
        }
      } catch {
        // ignore fetch errors during polling
      }
    }, 3000);
  };

  const handleTrack = async (url: string, status: 'posted' | 'passed') => {
    try {
      await fetch('/api/linkedin/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, status })
      });
      setOptions(prev => prev.filter(o => o.url !== url));
    } catch (err) {
      console.error('Failed to track url', err);
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text)
        .then(() => {
          setCopiedIndex(index);
          setTimeout(() => setCopiedIndex(null), 2000);
        })
        .catch(() => fallbackCopyTextToClipboard(text, index));
    } else {
      fallbackCopyTextToClipboard(text, index);
    }
  };

  const fallbackCopyTextToClipboard = (text: string, index: number) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    
    // Avoid scrolling to bottom
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      document.execCommand('copy');
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error('Fallback: Oops, unable to copy', err);
    }

    document.body.removeChild(textArea);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <div className="section-label" style={{ color: 'var(--text)', marginBottom: '8px' }}>LinkedIn Copilot</div>
          <p style={{ color: 'var(--muted)', fontSize: '13px' }}>
            Automatically discovers recent news articles in your focus areas and drafts posts in your voice.
          </p>
        </div>
        <button className="btn btn-primary" onClick={generateOptions} disabled={loading} style={{ minWidth: '220px', display: 'flex', justifyContent: 'center' }}>
          {loading ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Loader className="spin" size={16} /> Generating...
            </span>
          ) : (
            'Generate Post Options'
          )}
        </button>
      </div>

      {error && <div style={{ color: 'var(--red)', marginBottom: '20px' }}>{error}</div>}

      <div className="job-grid">
        {options.map((option, i) => (
          <div key={i} className="job-card fit-a" style={{ cursor: 'default' }}>
            <div className="card-identity">
              <div className="card-company">Draft Option {i + 1}</div>
              <div className="card-title">{option.title}</div>
            </div>
            
            <div style={{ marginTop: '10px' }}>
              <a href={option.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent)', fontSize: '11px', textDecoration: 'none', fontWeight: 600 }}>
                <ExternalLink size={12} /> Read Source Article
              </a>
            </div>

            <div style={{ background: 'var(--bg)', padding: '15px', borderRadius: '8px', marginTop: '15px', whiteSpace: 'pre-wrap', lineHeight: '1.5', fontSize: '12px', color: 'var(--muted)', flex: 1, border: '1px solid var(--border2)' }}>
              {option.postText}
            </div>

            <div style={{ marginTop: '20px', borderTop: '1px solid var(--border)', paddingTop: '15px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button className="btn" onClick={() => copyToClipboard(`${option.postText}\n\n${option.url}`, i)}>
                  <Copy size={14} /> Copy
                </button>
                {copiedIndex === i && <span style={{ color: '#10b981', fontSize: '12px', fontWeight: 600 }}>Copied!</span>}
              </div>
              <div style={{ flex: 1 }}></div>
              <button className="btn btn-danger" onClick={() => handleTrack(option.url, 'passed')}>
                <ThumbsDown size={14} /> Pass
              </button>
              <button className="btn btn-primary" onClick={() => handleTrack(option.url, 'posted')}>
                <Send size={14} /> Posted
              </button>
            </div>
          </div>
        ))}
      </div>

      {!loading && options.length === 0 && !error && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
          Click &quot;Generate Post Options&quot; to fetch fresh news and draft content.
        </div>
      )}
    </div>
  );
}
