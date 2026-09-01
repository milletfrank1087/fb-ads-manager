function postsManager() {
  return {
    isOpen: false,
    tab: 'generate',
    pageId: '113297813778299',

    topics: [],
    selectedTopicId: 'dc-vaccines',
    customPrompt: '',
    draftText: '',
    draftPillar: '',
    draftModel: '',

    posts: [],
    schedulerLogs: [],

    busy: {
      generate: false,
      publish: false,
      feed: false,
      schedRun: false,
    },

    toast: {
      show: false,
      message: '',
      type: 'info',
    },

    get selectedTopic() {
      return this.topics.find((t) => t.id === this.selectedTopicId);
    },

    get wordCount() {
      if (!this.draftText.trim()) return 0;
      return this.draftText.trim().split(/\s+/).length;
    },

    init() {
      this.loadTopics();
    },

    showToast(message, type = 'info') {
      this.toast.message = message;
      this.toast.type = type;
      this.toast.show = true;
      setTimeout(() => {
        this.toast.show = false;
      }, 4000);
    },

    async openManager(detail) {
      this.isOpen = true;
      document.body.style.overflow = 'hidden';
      if (detail?.tab) this.tab = detail.tab;
      await Promise.all([this.loadTopics(), this.refreshFeed(), this.loadSchedulerState()]);
    },

    close() {
      this.isOpen = false;
      document.body.style.overflow = '';
    },

    async loadTopics() {
      try {
        const res = await fetch('/api/posts/topics');
        const data = await res.json();
        if (data.ok && Array.isArray(data.topics)) {
          this.topics = data.topics;
        }
      } catch (err) {
        console.error('Failed to load topics:', err);
      }
    },

    async refreshFeed() {
      this.busy.feed = true;
      try {
        const res = await fetch('/api/posts?limit=50');
        const data = await res.json();
        if (data.ok && Array.isArray(data.posts)) {
          this.posts = data.posts;
          if (data.pageId) this.pageId = data.pageId;
        }
      } catch (err) {
        this.showToast('Failed to refresh live feed from Facebook', 'error');
      } finally {
        this.busy.feed = false;
      }
    },

    async loadSchedulerState() {
      try {
        const res = await fetch('/api/posts/scheduler');
        const data = await res.json();
        if (data.ok && Array.isArray(data.logs)) {
          this.schedulerLogs = data.logs;
        }
      } catch (err) {
        console.error('Failed to load scheduler state:', err);
      }
    },

    async generateContent() {
      this.busy.generate = true;
      try {
        const res = await fetch('/api/posts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topicId: this.customPrompt ? null : this.selectedTopicId,
            customPrompt: this.customPrompt || null,
          }),
        });
        const data = await res.json();
        if (data.ok && data.content) {
          this.draftText = data.content;
          this.draftPillar = data.pillar;
          this.draftModel = data.model;
          this.showToast('Post generated successfully via OpenRouter (Gemini 2.5 Flash Lite)', 'info');
        } else {
          this.showToast(data.message || data.error || 'Generation failed', 'error');
        }
      } catch (err) {
        this.showToast(`Generation error: ${err.message}`, 'error');
      } finally {
        this.busy.generate = false;
      }
    },

    async copyDraft() {
      if (!this.draftText) return;
      try {
        await navigator.clipboard.writeText(this.draftText);
        this.showToast('Post copied to clipboard', 'info');
      } catch (err) {
        this.showToast('Could not copy to clipboard', 'error');
      }
    },

    async publishDraft() {
      if (!this.draftText.trim()) return;

      const confirmed = window.confirm(
        `Are you sure you want to publish this post live to the RiseHope Facebook Page?\n\nWords: ${this.wordCount}\nCharacters: ${this.draftText.length}`
      );
      if (!confirmed) return;

      this.busy.publish = true;
      try {
        const res = await fetch('/api/posts/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: this.draftText,
            pillar: this.draftPillar,
            model: this.draftModel,
            topicId: this.customPrompt ? null : this.selectedTopicId,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          this.showToast('Post published live to RiseHope feed!', 'info');
          this.draftText = '';
          this.tab = 'feed';
          await this.refreshFeed();
        } else {
          this.showToast(data.message || data.error || 'Failed to publish post', 'error');
        }
      } catch (err) {
        this.showToast(`Publish error: ${err.message}`, 'error');
      } finally {
        this.busy.publish = false;
      }
    },

    async deleteLivePost(postId) {
      const confirmed = window.confirm(
        `Are you sure you want to delete post ${postId} from Facebook?\n\nNote: Meta API only allows deleting posts created by this app.`
      );
      if (!confirmed) return;

      try {
        const res = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
          method: 'DELETE',
        });
        const data = await res.json();
        if (data.ok) {
          this.showToast(`Post ${postId} deleted`, 'info');
          this.posts = this.posts.filter((p) => p.id !== postId);
        } else {
          this.showToast(data.message || data.error || 'Failed to delete post (only app-created posts can be deleted via API)', 'error');
        }
      } catch (err) {
        this.showToast(`Delete error: ${err.message}`, 'error');
      }
    },

    async triggerSchedulerRun() {
      this.busy.schedRun = true;
      try {
        const res = await fetch('/api/posts/scheduler/run', {
          method: 'POST',
        });
        const data = await res.json();
        if (data.ok) {
          this.showToast(`Auto-post generated and published: ${data.topic || 'Success'}`, 'info');
          await Promise.all([this.refreshFeed(), this.loadSchedulerState()]);
        } else {
          this.showToast(`Auto-post failed: ${data.error || 'Unknown error'}`, 'error');
          await this.loadSchedulerState();
        }
      } catch (err) {
        this.showToast(`Auto-post error: ${err.message}`, 'error');
      } finally {
        this.busy.schedRun = false;
      }
    },

    formatDate(iso) {
      if (!iso) return '—';
      try {
        const d = new Date(iso);
        return d.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      } catch {
        return iso;
      }
    },
  };
}
