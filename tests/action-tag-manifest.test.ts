import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertScriptPublishBody, assembleBody, buildScriptCatalogSnapshot } from '../src/shared/script-release.js';
import { Flow, ScriptReleaseManifest } from '../src/shared/contracts.js';

describe('Action Tag & Script Manifest Contract (RPA Admin)', () => {
  const baseManifest: ScriptReleaseManifest = {
    script_id: 'facebook-group-post',
    variables: [],
    outputs: [],
    steps: [{ id: 's1', action: 'CLICK' }],
    runtime_requirements: { runner_min: '2.0.0' },
    assets: [],
    action_tag_key: 'facebook.group.post',
    result_type: 'status',
  };

  const sampleVideoDemo = {
    artifact_ref: 'assets/demo.webm',
    thumbnail_ref: 'assets/demo.png',
    mime: 'video/webm' as const,
    test_run_id: 'tr_1',
    script_version: '1.0.0',
    reviewed: true,
    audio: false as const,
    desktop_capture: false as const,
  };

  it('validates a correct status script publish body', () => {
    const body: any = {
      package_key: 'script-facebook-group-post',
      kind: 'script',
      name: 'Facebook Group Post',
      version: '1.0.0',
      schema_version: 1,
      manifest: {
        ...baseManifest,
        video_demo: sampleVideoDemo,
      },
      script_request_id: 'req_123',
      dependencies: [],
      runtime_compatibility: { runner_min: '2.0.0' },
    };
    assert.doesNotThrow(() => assertScriptPublishBody(body));
  });

  it('validates a correct collection script publish body with collection_type', () => {
    const body: any = {
      package_key: 'script-facebook-group-collector',
      kind: 'script',
      name: 'Facebook Group Collector',
      version: '1.0.0',
      schema_version: 1,
      manifest: {
        ...baseManifest,
        action_tag_key: 'facebook.group.collect_posts',
        result_type: 'collection',
        collection_type: 'facebook.group.posts',
        video_demo: sampleVideoDemo,
      },
      dependencies: [],
      runtime_compatibility: { runner_min: '2.0.0' },
    };
    assert.doesNotThrow(() => assertScriptPublishBody(body));
  });

  it('rejects collection script when collection_type is missing or empty', () => {
    const body: any = {
      package_key: 'script-facebook-group-collector',
      kind: 'script',
      name: 'Facebook Group Collector',
      version: '1.0.0',
      schema_version: 1,
      manifest: {
        ...baseManifest,
        result_type: 'collection',
        collection_type: '',
        video_demo: sampleVideoDemo,
      },
      dependencies: [],
      runtime_compatibility: { runner_min: '2.0.0' },
    };
    assert.throws(
      () => assertScriptPublishBody(body),
      /SCRIPT_EXPORT: collection_type required when result_type is collection/
    );
  });

  it('rejects invalid result_type', () => {
    const body: any = {
      package_key: 'script-facebook-group-collector',
      kind: 'script',
      name: 'Facebook Group Collector',
      version: '1.0.0',
      schema_version: 1,
      manifest: {
        ...baseManifest,
        result_type: 'invalid_type',
        video_demo: sampleVideoDemo,
      },
      dependencies: [],
      runtime_compatibility: { runner_min: '2.0.0' },
    };
    assert.throws(
      () => assertScriptPublishBody(body),
      /SCRIPT_EXPORT: invalid result_type/
    );
  });

  it('assembleBody propagates action_tag_key, result_type, collection_type, and script_request_id', () => {
    const flow: Flow = {
      id: 'facebook-group-collector',
      name: 'Collector Flow',
      zoom: 1,
      steps: [],
      variables: [{ id: 'v1', key: 'limit', type: 'number', description: 'test' }],
      actionTagKey: 'facebook.group.collect_posts',
      scriptRequestId: 'req_collect_99',
      resultType: 'collection',
      collectionType: 'facebook.group.posts',
    };

    const assembled = assembleBody({ flow, steps: [], version: '1.1.0' }, []);
    assert.equal(assembled.script_request_id, 'req_collect_99');
    assert.equal(assembled.manifest.action_tag_key, 'facebook.group.collect_posts');
    assert.equal(assembled.manifest.result_type, 'collection');
    assert.equal(assembled.manifest.collection_type, 'facebook.group.posts');
  });

  it('assembleBody defaults result_type to status when unspecified', () => {
    const flow: Flow = {
      id: 'legacy-flow',
      name: 'Legacy Flow',
      zoom: 1,
      steps: [],
      variables: [],
    };

    const assembled = assembleBody({ flow, steps: [], version: '1.0.0' }, []);
    assert.equal(assembled.manifest.result_type, 'status');
    assert.equal(assembled.manifest.action_tag_key, undefined);
    assert.equal(assembled.manifest.collection_type, undefined);
    assert.equal(assembled.script_request_id, undefined);
  });

  it('buildScriptCatalogSnapshot captures manifest action_tag_key and result_type', () => {
    const flow: Flow = {
      id: 'facebook-post',
      name: 'FB Post',
      zoom: 1,
      steps: [],
      variables: [],
      actionTagKey: 'facebook.group.post',
      resultType: 'status',
    };

    const snapshot = buildScriptCatalogSnapshot({
      flow,
      steps: [],
      version: '1.0.0',
    });
    assert.equal(snapshot.action_tag_key, 'facebook.group.post');
    assert.equal(snapshot.result_type, 'status');
    assert.equal(snapshot.version, '1.0.0');
  });
});
