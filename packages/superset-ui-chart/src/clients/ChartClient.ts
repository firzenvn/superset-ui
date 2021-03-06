import { isDefined } from '@superset-ui/core';
import {
  SupersetClient,
  SupersetClientInterface,
  RequestConfig,
  Json,
  SupersetClientClass,
} from '@superset-ui/connection';
import { QueryFormData, Datasource } from '@superset-ui/query';
import getChartBuildQueryRegistry from '../registries/ChartBuildQueryRegistrySingleton';
import getChartMetadataRegistry from '../registries/ChartMetadataRegistrySingleton';
import { QueryData } from '../types/QueryResponse';
import { AnnotationLayerMetadata } from '../types/Annotation';
import { PlainObject } from '../types/Base';

// This expands to Partial<All> & (union of all possible single-property types)
type AtLeastOne<All, Each = { [K in keyof All]: Pick<All, K> }> = Partial<All> & Each[keyof Each];

export type SliceIdAndOrFormData = AtLeastOne<{
  sliceId: number;
  formData: Partial<QueryFormData>;
}>;

interface AnnotationData {
  [key: string]: PlainObject;
}

export interface ChartData {
  annotationData: AnnotationData;
  datasource: PlainObject;
  formData: QueryFormData;
  queryData: QueryData;
}

export default class ChartClient {
  readonly client: SupersetClientInterface | SupersetClientClass;

  constructor(
    config: {
      client?: SupersetClientInterface | SupersetClientClass;
    } = {},
  ) {
    const { client = SupersetClient } = config;
    this.client = client;
  }

  loadFormData(
    input: SliceIdAndOrFormData,
    options?: Partial<RequestConfig>,
  ): Promise<QueryFormData> {
    /* If sliceId is provided, use it to fetch stored formData from API */
    if ('sliceId' in input) {
      const promise = this.client
        .get({
          endpoint: `/api/v1/formData/?slice_id=${input.sliceId}`,
          ...options,
        } as RequestConfig)
        .then(response => response.json as Json)
        .then(json => json.form_data as QueryFormData);

      /*
       * If formData is also specified, override API result
       * with user-specified formData
       */
      return promise.then((dbFormData: QueryFormData) => ({
        ...dbFormData,
        ...input.formData,
      }));
    }

    /* If sliceId is not provided, returned formData wrapped in a Promise */
    return input.formData
      ? Promise.resolve(input.formData as QueryFormData)
      : Promise.reject(new Error('At least one of sliceId or formData must be specified'));
  }

  async loadQueryData(
    formData: QueryFormData,
    options?: Partial<RequestConfig>,
  ): Promise<QueryData> {
    const { viz_type: visType } = formData;
    const metaDataRegistry = getChartMetadataRegistry();
    const buildQueryRegistry = getChartBuildQueryRegistry();

    if (metaDataRegistry.has(visType)) {
      const { useLegacyApi } = metaDataRegistry.get(visType)!;
      const buildQuery = (await buildQueryRegistry.get(visType)) ?? (() => formData);

      return this.client
        .post({
          endpoint: useLegacyApi ? '/superset/explore_json/' : '/api/v1/query/',
          postPayload: {
            [useLegacyApi ? 'form_data' : 'query_context']: buildQuery(formData),
          },
          ...options,
        } as RequestConfig)
        .then(response => {
          // let's assume response.json always has the shape of QueryData
          return response.json as QueryData;
        });
    }

    return Promise.reject(new Error(`Unknown chart type: ${visType}`));
  }

  loadDatasource(datasourceKey: string, options?: Partial<RequestConfig>): Promise<Datasource> {
    return this.client
      .get({
        endpoint: `/superset/fetch_datasource_metadata?datasourceKey=${datasourceKey}`,
        ...options,
      } as RequestConfig)
      .then(response => response.json as Datasource);
  }

  // eslint-disable-next-line class-methods-use-this
  loadAnnotation(annotationLayer: AnnotationLayerMetadata): Promise<AnnotationData> {
    /* When annotation does not require query */
    if (!isDefined(annotationLayer.sourceType)) {
      return Promise.resolve({} as AnnotationData);
    }

    // TODO: Implement
    return Promise.reject(new Error('This feature is not implemented yet.'));
  }

  loadAnnotations(annotationLayers?: AnnotationLayerMetadata[]): Promise<AnnotationData> {
    if (Array.isArray(annotationLayers) && annotationLayers.length > 0) {
      return Promise.all(annotationLayers.map(layer => this.loadAnnotation(layer))).then(results =>
        annotationLayers.reduce((prev, layer, i) => {
          const output: AnnotationData = prev;
          output[layer.name] = results[i];

          return output;
        }, {}),
      );
    }

    return Promise.resolve({});
  }

  loadChartData(input: SliceIdAndOrFormData): Promise<ChartData> {
    return this.loadFormData(input).then(
      (
        formData: QueryFormData & {
          // eslint-disable-next-line camelcase
          annotation_layers?: AnnotationLayerMetadata[];
        },
      ) =>
        Promise.all([
          this.loadAnnotations(formData.annotation_layers),
          this.loadDatasource(formData.datasource),
          this.loadQueryData(formData),
        ]).then(([annotationData, datasource, queryData]) => ({
          annotationData,
          datasource,
          formData,
          queryData,
        })),
    );
  }
}
